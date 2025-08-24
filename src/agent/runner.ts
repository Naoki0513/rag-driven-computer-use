import { converseLoop } from './converse.js';
import { getDatabaseSchemaString } from './schema.js';
import { createSystemPromptWithSchema } from './prompt.js';
import { ensureSharedBrowserStarted, closeSharedBrowserWithDelay } from './tools/util.js';
import { startSessionTrace } from '../utilities/observability.js';

type ModelCandidate = { modelId: string; region: string };

function detectRegionFromModelId(modelId: string): string | null {
  const lower = String(modelId || '').toLowerCase();
  if (lower.startsWith('us.')) return 'us-west-2';
  if (lower.startsWith('eu.')) return 'eu-west-3';
  if (lower.startsWith('apac.')) return 'ap-northeast-1';
  return null;
}

function buildModelCandidates(): ModelCandidate[] {
  const listEnv = String(process.env.AGENT_BEDROCK_MODEL_IDS ?? '').trim();
  const singleModel = String(process.env.AGENT_BEDROCK_MODEL_ID ?? '').trim();
  const defaultRegion = String(process.env.AGENT_AWS_REGION ?? '').trim();
  const candidates: ModelCandidate[] = [];

  if (listEnv) {
    const ids = listEnv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const id of ids) {
      const region = detectRegionFromModelId(id) || defaultRegion;
      if (!region) {
        throw new Error(`モデルIDからリージョンを特定できませんでした。modelId=${id} に対応するリージョンが不明です（us./eu./apac. 接頭辞、または AGENT_AWS_REGION を設定してください）`);
      }
      candidates.push({ modelId: id, region });
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
      const region = detectRegionFromModelId(id) || defaultRegion;
      if (!region) {
        throw new Error('AGENT_AWS_REGION が未設定です (.env を確認)');
      }
      list.push({ modelId: id, region });
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
  } finally {
    // 完了時に5秒（または環境変数の指定 ms）待ってからクローズ
    await closeSharedBrowserWithDelay();
  }
}

