import { attachTodos, formatToolError, rerankPlainTextDocuments } from './util.js';
import { queryAll } from '../duckdb.js';
import { BedrockAgentRuntimeClient, RerankCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { recordRerankCallStart, recordRerankCallSuccess, recordRerankCallError, recordRerankUsage } from '../observability.js';

type UrlDoc = { id: string; url: string };
type PageSnapshotDoc = { id: string; url: string; text: string };

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

async function fetchAllPageSnapshotDocs(): Promise<PageSnapshotDoc[]> {
  const rows = await queryAll<{ snapshot?: string; URL?: string; id?: string }>(
    'SELECT "snapshotin MD" AS snapshot, "URL" AS url, CAST(id AS VARCHAR) AS id FROM pages'
  );
  const out: PageSnapshotDoc[] = [];
  for (const r of rows) {
    const url = String((r as any)?.url ?? '').trim();
    const id = String((r as any)?.id ?? '').trim();
    const raw = (r as any)?.snapshot ?? '';
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!id || !url) continue;
    if (!text) continue;
    out.push({ id, url, text });
  }
  return out;
}

async function rerankTextDocuments(query: string, docs: Array<{ text: string }>, numberOfResults: number, _client: BedrockAgentRuntimeClient, _modelArn: string, _region: string, name: string) {
  const texts = docs.map((d) => d.text);
  const out = await rerankPlainTextDocuments(query, texts, { topK: numberOfResults, category: 'search', name });
  return out.map((r) => ({ index: r.index, relevanceScore: r.score }));
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
    const searchTopEnv = Number(process.env.AGENT_SEARCH_TOP_K);
    const kUrl = Number.isFinite(searchTopEnv) && searchTopEnv > 0 ? Math.min(searchTopEnv, urlDocTexts.length) : Math.min(5, urlDocTexts.length);
    const urlResults = await rerankTextDocuments(q, urlDocTexts, kUrl, client, modelArn, region, 'URL Rerank');
    const urlTop5 = urlResults
      .slice(0, 5)
      .map((r) => {
        const meta = urlDocs[r.index];
        return meta ? { id: meta.id, url: meta.url } : null;
      })
      .filter(Boolean) as Array<{ id: string; url: string }>;

    // 2) snapshotin MD をページ単位でそのままリランク
    const pageDocs = await fetchAllPageSnapshotDocs();
    const pageDocTexts = pageDocs.map((d) => ({ text: d.text }));
    const kSnap = Number.isFinite(searchTopEnv) && searchTopEnv > 0 ? Math.min(searchTopEnv, pageDocTexts.length) : Math.min(5, pageDocTexts.length);
    const snapResults = await rerankTextDocuments(q, pageDocTexts, kSnap, client, modelArn, region, 'Snapshot Rerank');
    const snapshotTop5 = snapResults
      .slice(0, 5)
      .map((r) => {
        const meta = pageDocs[r.index];
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



