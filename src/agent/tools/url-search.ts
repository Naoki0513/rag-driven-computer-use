import { attachTodos, formatToolError } from './util.js';
import { queryAll } from '../duckdb.js';
import { BedrockAgentRuntimeClient, RerankCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { recordRerankCallStart, recordRerankCallSuccess, recordRerankCallError } from '../observability.js';

type UrlDoc = { id: string; url: string };
type SnapshotChunk = { id: string; url: string; chunkIndex: number; text: string };

function getRerankRegion(): string {
  const raw = String(process.env.AGENT_BEDROCK_RERANK_REGION || '').trim();
  if (raw) {
    const first = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)[0];
    if (first) return first;
  }
  // 既定は us-west-2（ユーザー要望）
  return 'us-west-2';
}

function getRerankModelArn(region: string): string {
  const envArn = String(process.env.AGENT_BEDROCK_RERANK_MODEL_ARN || '').trim();
  if (envArn) return envArn;
  // 既定: Cohere Rerank v3.5 （正しい ID 形式は v3-5:0）
  return `arn:aws:bedrock:${region}::foundation-model/cohere.rerank-v3-5:0`;
}

function chunkString(input: string, size: number): string[] {
  const s = String(input || '');
  if (size <= 0) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) {
    out.push(s.slice(i, i + size));
  }
  return out;
}

async function fetchAllUrlDocs(): Promise<UrlDoc[]> {
  const rows = await queryAll<{ URL?: string; id?: string }>(
    'SELECT "URL" AS url, CAST(id AS VARCHAR) AS id FROM pages WHERE "URL" IS NOT NULL'
  );
  const out: UrlDoc[] = [];
  for (const r of rows) {
    const url = String((r as any)?.url ?? '').trim();
    const id = String((r as any)?.id ?? '').trim();
    if (url && id) out.push({ id, url });
  }
  return out;
}

async function fetchAllSnapshotChunks(maxChunkLen: number): Promise<SnapshotChunk[]> {
  const rows = await queryAll<{ snapshotinMD?: string; snapshot?: string; URL?: string; id?: string }>(
    'SELECT COALESCE("snapshotin MD", "snapshotin MD") AS snapshot, "URL" AS url, CAST(id AS VARCHAR) AS id FROM pages'
  );
  const out: SnapshotChunk[] = [];
  for (const r of rows) {
    const url = String((r as any)?.url ?? '').trim();
    const id = String((r as any)?.id ?? '').trim();
    const raw = (r as any)?.snapshot ?? '';
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!id || !url) continue;
    if (!text) continue;
    const chunks = chunkString(text, maxChunkLen);
    for (let i = 0; i < chunks.length; i += 1) {
      out.push({ id, url, chunkIndex: i, text: chunks[i]! });
    }
  }
  return out;
}

async function rerankTextDocuments(query: string, docs: Array<{ text: string }>, numberOfResults: number, client: BedrockAgentRuntimeClient, modelArn: string, region: string, name: string) {
  // Bedrock Agent Runtime Rerank API 入力を構築
  const sources = docs.slice(0, 1000).map((d) => ({
    type: 'INLINE' as const,
    inlineDocumentSource: {
      type: 'TEXT' as const,
      textDocument: { text: d.text },
    },
  }));
  const cmd = new RerankCommand({
    queries: [{ type: 'TEXT', textQuery: { text: query } }],
    sources,
    rerankingConfiguration: {
      type: 'BEDROCK_RERANKING_MODEL',
      bedrockRerankingConfiguration: {
        numberOfResults,
        modelConfiguration: { modelArn },
      },
    },
  } as any);
  const handle = recordRerankCallStart({
    modelArn,
    region,
    input: {
      queries: [{ type: 'TEXT', textQuery: { text: query } }],
      sourcesPreviewCount: sources.length,
      numberOfResults,
    },
    name,
  });
  try {
    const res = await client.send(cmd);
    const results = (res as any)?.results ?? [];
    // サマリのみをメタデータに格納（全文はresに保持）
    const summary = Array.isArray(results)
      ? results.slice(0, numberOfResults).map((r: any, i: number) => ({ i, index: r?.index, score: r?.relevanceScore }))
      : [];
    recordRerankCallSuccess(handle, { response: res, resultsSummary: summary });
    return results as Array<{ index: number; relevanceScore: number }>;
  } catch (e: any) {
    recordRerankCallError(handle, e, { modelArn, region, numberOfResults, name });
    throw e;
  }
}

export async function urlSearch(query: string): Promise<string> {
  try {
    const q = String(query || '').trim();
    if (!q) {
      const payload = await attachTodos({ ok: false, action: 'url_search', error: 'エラー: query が空です' });
      return JSON.stringify(payload);
    }

    const region = getRerankRegion();
    const modelArn = getRerankModelArn(region);
    const client = new BedrockAgentRuntimeClient({ region });

    // 1) URL列を文書化してリランク（各ドキュメントはURLテキスト）
    const urlDocs = await fetchAllUrlDocs();
    const urlDocTexts = urlDocs.map((d) => ({ text: d.url }));
    const urlResults = await rerankTextDocuments(q, urlDocTexts, 5, client, modelArn, region, 'URL Rerank');
    const urlTop5 = urlResults
      .slice(0, 5)
      .map((r) => {
        const meta = urlDocs[r.index];
        return meta ? { id: meta.id, url: meta.url } : null;
      })
      .filter(Boolean) as Array<{ id: string; url: string }>;

    // 2) snapshotin MD を 500 文字チャンク化してリランク
    const chunks = await fetchAllSnapshotChunks(500);
    const chunkTexts = chunks.map((c) => ({ text: c.text }));
    const snapResults = await rerankTextDocuments(q, chunkTexts, 5, client, modelArn, region, 'Snapshot Rerank');
    const snapshotTop5 = snapResults
      .slice(0, 5)
      .map((r) => {
        const meta = chunks[r.index];
        return meta ? { id: meta.id, url: meta.url } : null;
      })
      .filter(Boolean) as Array<{ id: string; url: string }>;

    const payload = await attachTodos({ ok: true, action: 'url_search', query: q, results: { urlTop5, snapshotTop5 } });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ ok: false, action: 'url_search', error: formatToolError(e) });
    return JSON.stringify(payload);
  }
}



