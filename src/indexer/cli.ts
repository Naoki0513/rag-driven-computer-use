import 'dotenv/config';
import path from 'path';
import { IndexerProcessor } from './processor.js';
import type { IndexerConfig } from './types.js';
import { parseRegions } from './paths.js';

async function main() {
  console.log('WebGraph Indexer - スナップショット埋め込みインデックス作成ツール');
  
  // 環境変数から設定を読み込み
  const csvPath = String(process.env.INDEXER_CSV_PATH ?? '').trim() || 'output/crawl.csv';
  
  // INDEXER_INDEX_NAMEが未設定の場合、CSVファイル名（拡張子なし）を使用
  let indexName = String(process.env.INDEXER_INDEX_NAME ?? '').trim();
  if (!indexName) {
    const csvFileName = path.basename(csvPath);
    indexName = csvFileName.replace(/\.csv$/i, '') || 'default';
  }
  
  const outputDir = String(process.env.INDEXER_OUTPUT_DIR ?? '').trim() || 'output/indexes';
  const embeddingModel = String(process.env.INDEXER_EMBEDDING_MODEL ?? '').trim() || 'cohere.embed-v4:0';
  const regionsStr = String(process.env.INDEXER_AWS_REGION ?? '').trim() || 'ap-northeast-1';
  const providerStr = String(process.env.INDEXER_EMBEDDING_PROVIDER ?? '').trim() || 'bedrock';
  
  const maxChunkSizeEnv = String(process.env.INDEXER_MAX_CHUNK_SIZE ?? '').trim();
  const minChunkSizeEnv = String(process.env.INDEXER_MIN_CHUNK_SIZE ?? '').trim();
  const concurrencyEnv = String(process.env.INDEXER_EMBEDDING_CONCURRENCY ?? '').trim();
  
  const maxChunkSize = Number.isFinite(Number(maxChunkSizeEnv)) ? Math.trunc(Number(maxChunkSizeEnv)) : 5500;
  const minChunkSize = Number.isFinite(Number(minChunkSizeEnv)) ? Math.trunc(Number(minChunkSizeEnv)) : 500;
  const concurrency = Number.isFinite(Number(concurrencyEnv)) ? Math.max(1, Math.trunc(Number(concurrencyEnv))) : 1;
  
  const regions = parseRegions(regionsStr);
  const provider = (providerStr === 'cohere-api' || providerStr === 'bedrock') ? providerStr : 'bedrock';

  const config: IndexerConfig = {
    csvPath: path.resolve(process.cwd(), csvPath),
    indexName,
    outputDir: path.resolve(process.cwd(), outputDir),
    embeddingModel,
    regions,
    provider: provider as 'bedrock' | 'cohere-api',
    maxChunkSize,
    minChunkSize,
    concurrency
  };

  try {
    const processor = new IndexerProcessor(config);
    await processor.process();
    
    console.log('\n✅ インデックス作成が完了しました！');
    console.log('\n📁 生成されたファイル:');
    console.log(`   インデックス名: ${indexName}`);
    console.log(`   プロバイダー: ${provider}`);
    console.log(`   ディレクトリ: ${path.join(outputDir, indexName)}/`);
    console.log(`     ├── chunks.parquet          (チャンクメタデータ)`);
    console.log(`     ├── vectors.faiss           (ベクトルインデックス)`);
    console.log(`     └── vectors.faiss.mapping.json (chunk_id マッピング)`);
    console.log('\n🎯 Agent側での使用方法:');
    console.log('   .envに以下が設定されていれば、インデックス名だけで3ファイル全部読み込めます:');
    console.log(`   AGENT_INDEX_NAME=${indexName}`);
    console.log(`   AGENT_INDEX_DIR=${outputDir}`);
    if (provider === 'bedrock') {
      console.log('\n📊 リージョンフォールバック:');
      console.log(`   利用可能リージョン数: ${regions.length}`);
      console.log(`   順序: ${regions.join(' -> ')}`);
    }
    
    process.exit(0);
  } catch (e: any) {
    console.error('\n❌ エラーが発生しました:', e?.message ?? e);
    if (e?.stack) {
      console.error('\nスタックトレース:');
      console.error(e.stack);
    }
    process.exit(1);
  }
}

main();

