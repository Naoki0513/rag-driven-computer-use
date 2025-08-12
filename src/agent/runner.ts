import { converseLoop } from './bedrockClient.js';
import { getDatabaseSchemaString } from './schema.js';
import { createSystemPrompt } from './prompt.js';

export async function runSingleQuery(query: string): Promise<void> {
  const region = process.env.AWS_REGION;
  const modelId = process.env.BEDROCK_MODEL_ID;
  const dryRun = String(process.env.DRY_RUN_AGENT ?? 'false').toLowerCase() === 'true';
  if (!dryRun) {
    if (!region) throw new Error('AWS_REGION が未設定です (.env を確認)');
    if (!modelId) throw new Error('BEDROCK_MODEL_ID が未設定です (.env を確認)');
    // Neo4j接続情報チェック（実接続は schema.ts/ツールで行う）
    const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env;
    if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
      throw new Error('NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD が未設定です (.env を確認)');
    }
  }

  console.log('データベーススキーマを取得中...');
  const schema = await getDatabaseSchemaString();
  console.log('[OK] データベーススキーマを取得しました');

  if (dryRun) {
    console.log('DRY_RUN_AGENT: Bedrock呼び出しをスキップしました。');
    console.log(`Query: ${query}`);
    console.log(schema);
    return;
  }

  const systemPrompt = createSystemPrompt(schema);
  const { fullText, usage } = await converseLoop(query, systemPrompt, modelId!, region!);
  console.log(fullText);
  console.log('\nトークン使用情報:');
  console.log(`- 総入力トークン数: ${usage.input}`);
  console.log(`- 総出力トークン数: ${usage.output}`);
  console.log(`- 総キャッシュ読み取りトークン数: ${usage.cacheRead}`);
  console.log(`- 総キャッシュ書き込みトークン数: ${usage.cacheWrite}`);
  console.log(`- 総トークン数: ${usage.input + usage.output}`);
}


