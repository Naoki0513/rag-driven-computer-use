import { attachTodos, formatToolError, chunkSnapshotText, rerankPlainTextDocuments } from './util.js';
import { queryAll } from '../duckdb.js';

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
  const docs = chunks.map((d) => d.text);
  const results = await rerankPlainTextDocuments(query, docs, { topK, category: 'search', name: 'Snapshot Rerank' });
  return results.map((r) => ({ index: r.index, relevanceScore: r.score }));
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

    const envSearchTop = Number(process.env.AGENT_SEARCH_TOP_K);
    const desiredTopK = Number.isFinite(envSearchTop) && envSearchTop > 0 ? Math.min(envSearchTop, allChunks.length) : Math.min(5, allChunks.length);
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


