import { attachTodos, formatToolError, chunkSnapshotText, rerankPlainTextDocuments } from './util.js';
import { queryAll } from '../duckdb.js';

type SnapshotRow = { snapshot?: string; url?: string; id?: string };

type ChunkDoc = { chunk: string; url: string; id: string };

function normalizeSnapshotText(raw: string): string {
  let s = String(raw ?? '');
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  t = t
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
  t = t.replace(/\\\\/g, '\\');
  return t;
}

function splitKeywords(input: string): string[] {
  return String(input || '')
    .toLowerCase()
    .split(/[，、,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function snapshotSearch(input: { keywordQuery: string; rerankQuery: string; topK?: number }): Promise<string> {
  try {
    const keywordQuery = String((input as any)?.keywordQuery || '').trim();
    const rerankQuery = String((input as any)?.rerankQuery || '').trim();
    const topKInput = Math.trunc(Number((input as any)?.topK));
    if (!keywordQuery || !rerankQuery) {
      const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: 'エラー: keywordQuery と rerankQuery は必須です' });
      return JSON.stringify(payload);
    }

    const envMax = String(process.env.AGENT_SNAPSHOT_MAX_CHUNK_SIZE || '').trim();
    const envMin = String(process.env.AGENT_SNAPSHOT_MIN_CHUNK_SIZE || '').trim();
    const maxChunkSize = Number.isFinite(Number(envMax)) ? Math.max(100, Math.trunc(Number(envMax))) : 5500;
    const minChunkSize = Number.isFinite(Number(envMin)) ? Math.max(50, Math.trunc(Number(envMin))) : 500;

    // 1) 全レコードから snapshot と url/id を一括取得
    const t0 = Date.now();
    const rows = await queryAll<SnapshotRow>(
      'SELECT "snapshotfor AI" AS snapshot, "URL" AS url, CAST(id AS VARCHAR) AS id FROM pages'
    );

    // 2) 並列でチャンク化（URL/IDごと）
    const chunksPerRow = await Promise.all(rows.map(async (r) => {
      const snapshotRaw = typeof (r as any)?.snapshot === 'string' ? (r as any).snapshot as string : String((r as any)?.snapshot ?? '');
      const snapshot = normalizeSnapshotText(snapshotRaw);
      const url = String((r as any)?.url ?? '').trim();
      const id = String((r as any)?.id ?? '').trim();
      if (!snapshot || (!url && !id)) return [] as ChunkDoc[];
      const chunks = chunkSnapshotText(snapshot, maxChunkSize, minChunkSize);
      return chunks.map((c) => ({ chunk: c, url, id }));
    }));
    const allChunks: ChunkDoc[] = ([] as ChunkDoc[]).concat(...chunksPerRow);
    try {
      console.info(`[snapshot_search] rows=${rows.length} totalChunks=${allChunks.length} keywordQuery="${keywordQuery}" rerankQuery="${rerankQuery}"`);
    } catch {}

    if (!allChunks.length) {
      const payload = await attachTodos({ ok: true, action: 'snapshot_search', results: [] });
      return JSON.stringify(payload);
    }

    // 3) AND 部分一致（大文字小文字無視）でフィルタ（チャンク本文のみ。URLは含めない）
    const terms = splitKeywords(keywordQuery);
    const filtered: ChunkDoc[] = terms.length
      ? allChunks.filter(({ chunk }) => {
          const lc = chunk.toLowerCase();
          for (const kw of terms) { if (lc.includes(kw)) return true; }
          return false;
        })
      : allChunks;
    try {
      console.info(`[snapshot_search] keyword(OR) terms=${JSON.stringify(terms)} matchedChunks=${filtered.length}`);
    } catch {}

    if (!filtered.length) {
      const payload = await attachTodos({ ok: true, action: 'snapshot_search', results: [] });
      return JSON.stringify(payload);
    }

    // 4) Rerank（URLを先頭に付加してリランクの意味手掛かりにする）
    const rerankDocs = filtered.map((d) => ({ text: `${d.url}\n\n${d.chunk}` }));
    const envDefaultTop = Number(process.env.AGENT_SEARCH_TOP_K);
    const defaultTop = Number.isFinite(envDefaultTop) && envDefaultTop > 0 ? envDefaultTop : 5;
    const requestedTop = Number.isFinite(topKInput) && topKInput > 0 ? topKInput : defaultTop;
    const k = Math.min(requestedTop, rerankDocs.length);
    if (filtered.length > 1000) {
      try { console.info(`[snapshot_search] rerank source capped to 1000 by implementation (filtered=${filtered.length})`); } catch {}
    }
    try {
      console.info(`[snapshot_search] rerankCandidates=${rerankDocs.length} topK=${k}`);
    } catch {}
    const reranked = await rerankPlainTextDocuments(rerankQuery, rerankDocs.map((d) => d.text), { topK: k, category: 'search', name: 'Snapshot Search' });
    const top = reranked.slice(0, k).map((r) => {
      const meta = filtered[r.index];
      if (!meta) return null;
      return { id: meta.id, url: meta.url, chunk: meta.chunk };
    }).filter(Boolean) as Array<{ id: string; url: string; chunk: string }>;
    try {
      const ms = Date.now() - t0;
      console.info(`[snapshot_search] returned=${top.length} elapsedMs=${ms}`);
    } catch {}

    const payload = await attachTodos({ ok: true, action: 'snapshot_search', results: top });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: formatToolError(e) });
    return JSON.stringify(payload);
  }
}


