import 'dotenv/config';
import { IndexLoader } from '../indexer/loader.js';

async function main() {
  console.log('========================================');
  console.log('[Test] IndexLoader 動作確認');
  console.log('========================================\n');

  // 環境変数から読み込み
  const indexName = String(process.env.AGENT_INDEX_NAME ?? '').trim();
  const indexDir = String(process.env.AGENT_INDEX_DIR ?? '').trim() || 'output/indexes';

  if (!indexName) {
    console.error('❌ AGENT_INDEX_NAME が設定されていません');
    process.exit(1);
  }

  console.log(`インデックス名: ${indexName}`);
  console.log(`ベースディレクトリ: ${indexDir}\n`);

  const loader = new IndexLoader(indexName, indexDir);
  const info = loader.getInfo();
  
  console.log('📁 パス情報:');
  console.log(`  - チャンク: ${info.paths.chunksPath}`);
  console.log(`  - ベクトル: ${info.paths.vectorsPath}`);
  console.log(`  - マッピング: ${info.paths.mappingPath}\n`);

  // ベクトルストア読み込み
  console.log('[1/2] ベクトルストア読み込み中...');
  const vectorStore = await loader.loadVectorStore();
  console.log(`✓ ベクトル数: ${vectorStore.getSize()}\n`);

  // チャンクメタデータ読み込み
  console.log('[2/2] チャンクメタデータ読み込み中...');
  const chunks = await loader.loadAllChunks();
  console.log(`✓ チャンク数: ${chunks.length}\n`);

  // サンプル表示
  console.log('📊 最初の3チャンク:');
  chunks.slice(0, 3).forEach((chunk, i) => {
    console.log(`  ${i + 1}. ${chunk.chunk_id}`);
    console.log(`     URL: ${chunk.url}`);
    console.log(`     サイズ: ${chunk.char_count}文字`);
    console.log(`     プレビュー: ${chunk.chunk_text.substring(0, 100).replace(/\n/g, '\\n')}...\n`);
  });

  console.log('========================================');
  console.log('✅ テスト完了');
  console.log('========================================');
}

main().catch(e => {
  console.error('❌ エラー:', e);
  process.exit(1);
});

