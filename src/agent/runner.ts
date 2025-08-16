import { converseLoop } from './bedrockClient.js';
import { getDatabaseSchemaString } from './schema.js';
import { createSystemPromptWithSchema } from './prompt.js';

export async function runSingleQuery(query: string): Promise<void> {
  const region = process.env.AGENT_AWS_REGION;
  const modelId = process.env.AGENT_BEDROCK_MODEL_ID;
  console.log('WebGraph-Agent Cypher AI エージェントを起動しています...');
  if (!region) throw new Error('AGENT_AWS_REGION が未設定です (.env を確認)');
  if (!modelId) throw new Error('AGENT_BEDROCK_MODEL_ID が未設定です (.env を確認)');
  // Neo4j接続情報チェック（実接続は schema.ts/ツールで行う）
  const { AGENT_NEO4J_URI, AGENT_NEO4J_USER, AGENT_NEO4J_PASSWORD } = process.env as any;
  if (!AGENT_NEO4J_URI || !AGENT_NEO4J_USER || !AGENT_NEO4J_PASSWORD) {
    throw new Error('AGENT_NEO4J_URI/AGENT_NEO4J_USER/AGENT_NEO4J_PASSWORD が未設定です (.env を確認)');
  }
  console.log(`[OK] 実行環境チェックに成功しました (AGENT_AWS_REGION=${region}, MODEL=${modelId})`);

  console.log('データベーススキーマを取得中...');
  const schema = await getDatabaseSchemaString();
  console.log('[OK] データベーススキーマを取得しました');

  const systemPrompt = createSystemPromptWithSchema(schema);
  console.log(`\n実行中のクエリ: ${query}`);
  console.log('\nエージェント:');
  const { fullText, usage } = await converseLoop(query, systemPrompt, modelId!, region!);
  console.log(fullText);
  console.log('\nトークン使用情報:');
  console.log(`- 総入力トークン数: ${usage.input}`);
  console.log(`- 総出力トークン数: ${usage.output}`);
  console.log(`- 総キャッシュ読み取りトークン数: ${usage.cacheRead}`);
  console.log(`- 総キャッシュ書き込みトークン数: ${usage.cacheWrite}`);
  console.log(`- 総トークン数: ${usage.input + usage.output}`);
}

