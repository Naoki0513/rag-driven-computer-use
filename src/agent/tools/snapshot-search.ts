import { attachTodos, formatToolError } from './util.js';
import { queryAll } from '../duckdb.js';
import { BedrockAgentRuntimeClient, RerankCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { recordRerankCallStart, recordRerankCallSuccess, recordRerankCallError } from '../observability.js';

type SnapshotRow = { snapshot?: string; url?: string; id?: string };

type ChunkDoc = { text: string; url: string; id: string };

function getRerankRegion(): string {
  const raw = String(process.env.AGENT_BEDROCK_RERANK_REGION || '').trim();
  if (raw) {
    const first = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)[0];
    if (first) return first;
  }
  return 'us-west-2';
}

function getRerankModelArn(region: string): string {
  const envArn = String(process.env.AGENT_BEDROCK_RERANK_MODEL_ARN || '').trim();
  if (envArn) return envArn;
  return `arn:aws:bedrock:${region}::foundation-model/cohere.rerank-v3-5:0`;
}

type Line = { idx: number; indent: number; text: string; depth: number };

function normalizeSnapshotText(raw: string): string {
  // CSVに格納される際に二重引用符やバックスラッシュエスケープで改行が潰れているケースを復元
  let s = String(raw ?? '');
  let t = s.trim();
  // 外側のクォートを剥がす（"..." or '...')
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  // 代表的なエスケープの復元
  // 順序: \r\n/\n/\t → 実改行/タブ、\" → ", 残った二重バックスラッシュは一部復元
  t = t
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
  // 末尾に余計なバックスラッシュが残り続けるのを避けるための軽い復元
  // 但し、\\→\ は最小限に留める
  t = t.replace(/\\\\/g, '\\');
  return t;
}

function parseLines(snapshot: string): Line[] {
  const out: Line[] = [];
  const stack: number[] = [];
  const lines = String(snapshot || '').split(/\r?\n/);
  const re = /^(\s*)-?\s*(.*)$/;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (!raw || !raw.trim()) continue;
    const m = re.exec(raw);
    const spaces = m ? (m[1] ?? '') : '';
    const rest = m ? (m[2] ?? '') : raw.trim();
    const indent = spaces.length;
    while (stack.length && indent < stack[stack.length - 1]!) stack.pop();
    if (!stack.length || indent > stack[stack.length - 1]!) stack.push(indent);
    const depth = Math.max(0, stack.length - 1);
    out.push({ idx: i, indent, text: rest.trim(), depth });
  }
  return out;
}

function splitByDepth(lines: Line[], start: number, end: number, targetDepth: number): Array<[number, number]> {
  const anchors: number[] = [];
  for (let i = start; i <= end; i += 1) if (lines[i]!.depth === targetDepth) anchors.push(i);
  if (!anchors.length) return [[start, end]];
  const segs: Array<[number, number]> = [];
  for (let j = 0; j < anchors.length; j += 1) {
    const a = anchors[j]!;
    const b = (j + 1 < anchors.length) ? (anchors[j + 1]! - 1) : end;
    segs.push([a, b]);
  }
  return segs;
}

function headerChain(lines: Line[], startIdx: number): string[] {
  const chain: string[] = [];
  let curDepth = lines[startIdx]!.depth - 1;
  let pos = startIdx - 1;
  const parents: Line[] = [];
  while (curDepth >= 0 && pos >= 0) {
    if (lines[pos]!.depth === curDepth) {
      parents.push(lines[pos]!);
      curDepth -= 1;
    }
    pos -= 1;
  }
  parents.reverse();
  let base = 0;
  for (const p of parents) {
    chain.push(`${' '.repeat(base)}- ${p.text}`);
    base += 2;
  }
  return chain;
}

function commonPrefix<T>(lists: T[][]): T[] {
  if (!lists.length) return [];
  const minLen = Math.min(...lists.map((l) => l.length));
  const out: T[] = [];
  for (let i = 0; i < minLen; i += 1) {
    const token = lists[0]![i]!;
    let ok = true;
    for (let k = 1; k < lists.length; k += 1) if (lists[k]![i] !== token) { ok = false; break; }
    if (!ok) break;
    out.push(token);
  }
  return out;
}

function buildChunkTextGrouped(lines: Line[], segs: Array<[number, number]>): string {
  const chains = segs.map(([s]) => headerChain(lines, s));
  const groups = new Map<string, Array<[number, number]>>();
  for (let i = 0; i < segs.length; i += 1) {
    const keyList = chains[i]!;
    const key = JSON.stringify(keyList);
    const list = groups.get(key) || [];
    list.push(segs[i]!);
    groups.set(key, list);
  }
  const ordered = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const chainLists = ordered.map(([k]) => JSON.parse(k) as string[]);
  const cp = commonPrefix(chainLists);
  const parts: string[] = [];
  if (cp.length) parts.push(...cp);
  for (let gi = 0; gi < ordered.length; gi += 1) {
    const chain = chainLists[gi]!;
    const seglist = ordered[gi]![1]!;
    const rem = chain.slice(cp.length);
    if (rem.length) parts.push(...rem);
    for (const [s, e] of seglist) {
      for (let i = s; i <= e; i += 1) parts.push(`${' '.repeat(lines[i]!.indent)}- ${lines[i]!.text}`);
      parts.push('');
    }
  }
  return parts.join('\n').replace(/\n+$/, '');
}

function chunkChars(lines: Line[], segs: Array<[number, number]>): number {
  return buildChunkTextGrouped(lines, segs).length;
}

function chunkSnapshotText(snapshot: string, maxSize: number, minSize: number): string[] {
  const lines = parseLines(snapshot);
  if (!lines.length) return [];
  const maxDepth = Math.max(...lines.map((l) => l.depth));

  const initial = splitByDepth(lines, 0, lines.length - 1, 0);
  let chunks: Array<Array<[number, number]>> = initial.map((seg) => [seg]);
  let currentDepth = 1;
  while (true) {
    let changed = false;
    const next: Array<Array<[number, number]>> = [];
    for (const segs of chunks) {
      if (chunkChars(lines, segs) <= maxSize || currentDepth > maxDepth) {
        next.push(segs);
        continue;
      }
      for (const [s, e] of segs) {
        const subs = splitByDepth(lines, s, e, currentDepth);
        if (subs.length === 1) {
          next.push([subs[0]!]);
        } else {
          changed = true;
          for (const sub of subs) next.push([sub]);
        }
      }
    }
    chunks = next;
    if (!changed) {
      if (chunks.every((segs) => chunkChars(lines, segs) <= maxSize)) break;
    }
    currentDepth += 1;
    if (currentDepth > maxDepth) break;
  }

  let i = 0;
  while (i < chunks.length) {
    const size = chunkChars(lines, chunks[i]!);
    if (size < minSize) {
      if (i + 1 < chunks.length) {
        chunks[i] = chunks[i]!.concat(chunks[i + 1]!);
        chunks.splice(i + 1, 1);
        continue;
      } else if (i - 1 >= 0) {
        chunks[i - 1] = chunks[i - 1]!.concat(chunks[i]!);
        chunks.splice(i, 1);
        i -= 1;
        continue;
      }
    }
    i += 1;
  }

  return chunks.map((segs) => buildChunkTextGrouped(lines, segs));
}

async function fetchSnapshotsByIds(ids: string[]): Promise<SnapshotRow[]> {
  const list = Array.from(new Set(ids.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0)));
  if (!list.length) return [];
  const inList = list
    .map((v) => v.replace(/'/g, "''"))
    .map((v) => `'${v}'`)
    .join(',');
  const sql = `SELECT "snapshotfor AI" AS snapshot, "URL" AS url, CAST(id AS VARCHAR) AS id FROM pages WHERE CAST(id AS VARCHAR) IN (${inList})`;
  const rows = await queryAll<SnapshotRow>(sql);
  return rows;
}

async function fetchSnapshotsByUrls(urls: string[]): Promise<SnapshotRow[]> {
  const list = Array.from(new Set(urls.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0)));
  if (!list.length) return [];
  const inList = list
    .map((v) => v.replace(/'/g, "''"))
    .map((v) => `'${v}'`)
    .join(',');
  const sql = `SELECT "snapshotfor AI" AS snapshot, "URL" AS url, CAST(id AS VARCHAR) AS id FROM pages WHERE "URL" IN (${inList})`;
  const rows = await queryAll<SnapshotRow>(sql);
  return rows;
}

async function rerankChunks(query: string, chunks: ChunkDoc[], topK: number) {
  const region = getRerankRegion();
  const modelArn = getRerankModelArn(region);
  const client = new BedrockAgentRuntimeClient({ region });
  const MAX_DOC_LEN = 32000;
  const sources = chunks.slice(0, 1000).map((d) => ({
    type: 'INLINE' as const,
    inlineDocumentSource: {
      type: 'TEXT' as const,
      textDocument: { text: String(d.text ?? '').slice(0, MAX_DOC_LEN) },
    },
  }));
  const k = Math.max(0, Math.min(topK, sources.length));
  if (k === 0) {
    return [] as Array<{ index: number; relevanceScore: number }>; // 返すものがない
  }
  const cmd = new RerankCommand({
    queries: [{ type: 'TEXT', textQuery: { text: query } }],
    sources,
    rerankingConfiguration: {
      type: 'BEDROCK_RERANKING_MODEL',
      bedrockRerankingConfiguration: { numberOfResults: k, modelConfiguration: { modelArn } },
    },
  } as any);
  const handle = recordRerankCallStart({ modelArn, region, input: { query, sourcesPreviewCount: sources.length, numberOfResults: topK }, name: 'Snapshot Rerank' });
  try {
    const res = await client.send(cmd);
    const results = (res as any)?.results ?? [];
    const summary = Array.isArray(results) ? results.slice(0, topK).map((r: any, i: number) => ({ i, index: r?.index, score: r?.relevanceScore })) : [];
    recordRerankCallSuccess(handle, { response: res, resultsSummary: summary });
    return results as Array<{ index: number; relevanceScore: number }>;
  } catch (e: any) {
    recordRerankCallError(handle, e, { modelArn, region, numberOfResults: topK, name: 'Snapshot Rerank' });
    throw e;
  }
}

export async function snapshotSearch(input: { ids?: string[]; urls?: string[]; query: string }): Promise<string> {
  try {
    const q = String((input as any)?.query || '').trim();
    const idsIn = Array.isArray((input as any)?.ids) ? (input as any).ids.map((s: any) => String(s ?? '').trim()).filter((s: string) => s.length > 0) : [];
    const urlsIn = Array.isArray((input as any)?.urls) ? (input as any).urls.map((s: any) => String(s ?? '').trim()).filter((s: string) => s.length > 0) : [];
    const envMax = String(process.env.AGENT_SNAPSHOT_MAX_CHUNK_SIZE || '').trim();
    const envMin = String(process.env.AGENT_SNAPSHOT_MIN_CHUNK_SIZE || '').trim();
    const maxChunkSize = Number.isFinite(Number(envMax)) ? Math.max(100, Math.trunc(Number(envMax))) : 5500;
    const minChunkSize = Number.isFinite(Number(envMin)) ? Math.max(50, Math.trunc(Number(envMin))) : 500;

    if (!q) {
      const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: 'エラー: query が空です' });
      return JSON.stringify(payload);
    }
    if (!idsIn.length && !urlsIn.length) {
      const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: 'エラー: ids または urls を少なくとも1つ指定してください' });
      return JSON.stringify(payload);
    }

    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    const rowsA = await fetchSnapshotsByIds(idsIn);
    const rowsB = await fetchSnapshotsByUrls(urlsIn);
    const rows: SnapshotRow[] = [];
    for (const r of [...rowsA, ...rowsB]) {
      const id = String((r as any)?.id ?? '').trim();
      const url = String((r as any)?.url ?? '').trim();
      const key = `${id}::${url}`;
      if (!id && !url) continue;
      if (id && seenIds.has(id) && url && seenUrls.has(url)) continue;
      rows.push(r);
      if (id) seenIds.add(id);
      if (url) seenUrls.add(url);
    }

    if (!rows.length) {
      const payload = await attachTodos({ ok: true, action: 'snapshot_search', query: q, results: [], note: '該当する snapshotfor AI が見つかりませんでした' });
      return JSON.stringify(payload);
    }

    const allChunks: ChunkDoc[] = [];
    for (const r of rows) {
      const snapshotRaw = typeof (r as any)?.snapshot === 'string' ? (r as any).snapshot as string : String((r as any)?.snapshot ?? '');
      const snapshot = normalizeSnapshotText(snapshotRaw);
      const url = String((r as any)?.url ?? '').trim();
      const id = String((r as any)?.id ?? '').trim();
      if (!snapshot || (!url && !id)) continue;
      const chunks = chunkSnapshotText(snapshot, maxChunkSize, minChunkSize);
      for (const c of chunks) allChunks.push({ text: c, url, id });
    }

    if (!allChunks.length) {
      const payload = await attachTodos({ ok: true, action: 'snapshot_search', query: q, results: [], note: '有効なチャンクを生成できませんでした' });
      return JSON.stringify(payload);
    }

    const desiredTopK = Math.min(5, allChunks.length);
    const reranked = await rerankChunks(q, allChunks, desiredTopK);
    const top5 = reranked.slice(0, 5).map((r) => {
      const meta = allChunks[r.index];
      if (!meta) return null;
      return { id: meta.id, url: meta.url, score: r.relevanceScore, chunk: meta.text };
    }).filter(Boolean) as Array<{ id: string; url: string; score: number; chunk: string }>;

    const payload = await attachTodos({ ok: true, action: 'snapshot_search', query: q, inputs: { ids: idsIn, urls: urlsIn }, results: top5, meta: { inputChunks: allChunks.length, maxChunkSize, minChunkSize } });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: formatToolError(e) });
    return JSON.stringify(payload);
  }
}


