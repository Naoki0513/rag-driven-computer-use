import { converseLoop } from './converse.js';
import { getDatabaseSchemaString } from './schema.js';
import { createSystemPromptWithSchema } from './prompt.js';
import { ensureSharedBrowserStarted, closeSharedBrowserWithDelay } from './tools/util.js';
import { startSessionTrace } from './observability.js';
import { promises as fs } from 'fs';
import path from 'path';

type ModelCandidate = { modelId: string; region: string };

function detectRegionFromModelId(modelId: string): string | null {
  const lower = String(modelId || '').toLowerCase();
  if (lower.startsWith('us.')) return 'us-west-2';
  if (lower.startsWith('eu.')) return 'eu-west-3';
  if (lower.startsWith('apac.')) return 'ap-northeast-1';
  return null;
}

function parseRegionsFromEnv(): string[] {
  const raw = String(process.env.AGENT_AWS_REGION ?? '').trim();
  if (!raw) return [];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // 重複排除（順序維持）
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of list) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

function regionsMatchingModelIdPrefix(modelId: string, regions: string[]): string[] {
  const lower = String(modelId || '').toLowerCase();
  if (!regions.length) return [];
  if (lower.startsWith('us.')) return regions.filter((r) => r.startsWith('us-'));
  if (lower.startsWith('eu.')) return regions.filter((r) => r.startsWith('eu-'));
  if (lower.startsWith('apac.')) return regions.filter((r) => r.startsWith('ap-'));
  return regions;
}

function buildModelCandidates(): ModelCandidate[] {
  const listEnv = String(process.env.AGENT_BEDROCK_MODEL_IDS ?? '').trim();
  const singleModel = String(process.env.AGENT_BEDROCK_MODEL_ID ?? '').trim();
  const regionList = parseRegionsFromEnv();
  const candidates: ModelCandidate[] = [];

  if (listEnv) {
    const ids = listEnv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const id of ids) {
      // AGENT_AWS_REGION に複数渡された場合は、その全リージョン（モデル接頭辞に合致するもの）で候補を生成
      const regionCandidates = regionsMatchingModelIdPrefix(id, regionList);
      if (regionCandidates.length > 0) {
        for (const r of regionCandidates) candidates.push({ modelId: id, region: r });
      } else {
        const fallback = detectRegionFromModelId(id) || regionList[0];
        if (!fallback) {
          throw new Error(`モデルIDからリージョンを特定できませんでした。modelId=${id} に対応するリージョンが不明です（us./eu./apac. 接頭辞、または AGENT_AWS_REGION を設定してください）`);
        }
        candidates.push({ modelId: id, region: fallback });
      }
    }
    return candidates;
  }

  if (singleModel) {
    // 単一変数にカンマ区切りで渡された場合もサポート
    const ids = singleModel.includes(',')
      ? singleModel.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [singleModel];
    const list: ModelCandidate[] = [];
    for (const id of ids) {
      const regionCandidates = regionsMatchingModelIdPrefix(id, regionList);
      if (regionCandidates.length > 0) {
        for (const r of regionCandidates) list.push({ modelId: id, region: r });
      } else {
        const fallback = detectRegionFromModelId(id) || regionList[0];
        if (!fallback) {
          throw new Error('AGENT_AWS_REGION が未設定です (.env を確認)');
        }
        list.push({ modelId: id, region: fallback });
      }
    }
    return list;
  }

  throw new Error('AGENT_BEDROCK_MODEL_IDS もしくは AGENT_BEDROCK_MODEL_ID が未設定です (.env を確認)');
}

export async function runSingleQuery(query: string): Promise<void> {
  console.log('WebGraph-Agent Cypher AI エージェントを起動しています...');
  // Neo4j接続情報チェック（実接続は schema.ts/ツールで行う）
  const { AGENT_NEO4J_URI, AGENT_NEO4J_USER, AGENT_NEO4J_PASSWORD } = process.env as any;
  if (!AGENT_NEO4J_URI || !AGENT_NEO4J_USER || !AGENT_NEO4J_PASSWORD) {
    throw new Error('AGENT_NEO4J_URI/AGENT_NEO4J_USER/AGENT_NEO4J_PASSWORD が未設定です (.env を確認)');
  }
  const candidates = buildModelCandidates();
  console.log(`[OK] 実行環境チェックに成功しました。モデル候補数=${candidates.length}`);

  // Langfuse セッション（1回の runSingleQuery を1セッションとして紐づけ）
  const sessionId = `agent-session-${Date.now()}`;
  startSessionTrace(sessionId, 'WebGraph Agent Session', { queryPreview: query.slice(0, 120) });

  // まず最初にブラウザを起動（以降の実行で共有・再利用）
  await ensureSharedBrowserStarted();
  try {
    console.log('データベーススキーマを取得中...');
    const schema = await getDatabaseSchemaString();
    console.log('[OK] データベーススキーマを取得しました');

    const systemPrompt = createSystemPromptWithSchema(schema);
    console.log(`\n実行中のクエリ: ${query}`);
    console.log('\nエージェント:');

    const { fullText, usage } = await converseLoop(query, systemPrompt, candidates);
    console.log(fullText);
    console.log('\nトークン使用情報:');
    console.log(`- 総入力トークン数: ${usage.input}`);
    console.log(`- 総出力トークン数: ${usage.output}`);
    console.log(`- 総キャッシュ読み取りトークン数: ${usage.cacheRead}`);
    console.log(`- 総キャッシュ書き込みトークン数: ${usage.cacheWrite}`);
    console.log(`- 総トークン数: ${usage.input + usage.output}`);

    // ToDo ファイルの内容を最後にログ出力（検証用）
    try {
      const todoPath = path.resolve(process.cwd(), 'todo.md');
      const content = (await fs.readFile(todoPath)).toString('utf-8');
      console.log('\n現在の ToDo (todo.md):');
      console.log('----------------------------------------');
      console.log(content.trim() || '(空)');
      console.log('----------------------------------------');
    } catch {
      console.log('\n現在の ToDo (todo.md): (ファイルなし)');
    }
  } finally {
    // 完了時に5秒（または環境変数の指定 ms）待ってからクローズ
    await closeSharedBrowserWithDelay();
  }
}

