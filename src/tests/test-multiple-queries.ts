import 'dotenv/config';
import { IndexLoader } from '../indexer/loader.js';
import { EmbeddingsService } from '../indexer/embeddings.js';
import { parseRegions } from '../indexer/paths.js';

async function main() {
  console.log('========================================');
  console.log('[Test] 複数クエリでのベクトル検索テスト');
  console.log('========================================\n');

  // インデックス読み込み
  const indexName = String(process.env.AGENT_INDEX_NAME ?? '').trim() || 'shopping';
  const indexDir = String(process.env.AGENT_INDEX_DIR ?? '').trim() || 'output/indexes';
  
  const loader = new IndexLoader(indexName, indexDir);
  const vectorStore = await loader.loadVectorStore();
  const chunks = await loader.loadAllChunks();
  
  console.log(`✓ インデックス読み込み: ${chunks.length}チャンク\n`);

  // 埋め込みサービス
  const embeddingModel = String(process.env.INDEXER_EMBEDDING_MODEL ?? '').trim() || 'cohere.embed-v4:0';
  const regionsStr = String(process.env.INDEXER_AWS_REGION ?? '').trim() || 'ap-northeast-1';
  const regions = parseRegions(regionsStr);
  const embeddingService = new EmbeddingsService(regions, embeddingModel);

  // 複数のクエリでテスト
  const testQueries = [
    "Dashboard",
    "Customer",
    "Sales Report",
    "Magento Admin",
  ];

  for (const query of testQueries) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 クエリ: "${query}"`);
    console.log('='.repeat(60));
    
    try {
      // クエリを埋め込み
      const queryVector = await embeddingService.embedQuery(query);
      
      // 類似検索
      const results = vectorStore.search(queryVector, 3);
      
      console.log(`\n📊 検索結果: ${results.length}件\n`);
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const chunk = chunks.find(c => c.chunk_id === result.chunkId);
        
        console.log(`${i + 1}. スコア: ${result.score.toFixed(4)} | ${result.chunkId}`);
        if (chunk) {
          console.log(`   URL: ${chunk.url}`);
          const preview = chunk.chunk_text
            .substring(0, 200)
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          console.log(`   内容: ${preview}...\n`);
        }
      }
      
      // スコアの妥当性確認
      const scores = results.map(r => r.score);
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);
      
      if (maxScore > 0.2) {
        console.log(`✓ 最高スコア ${maxScore.toFixed(4)} → 関連性あり`);
      } else {
        console.log(`⚠ 最高スコア ${maxScore.toFixed(4)} → 関連性が低い可能性`);
      }
      
    } catch (e: any) {
      console.error(`❌ エラー: ${e?.message ?? e}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ すべてのクエリテストが完了しました！');
  console.log('='.repeat(60));
}

main();


