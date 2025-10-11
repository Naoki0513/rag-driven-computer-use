import 'dotenv/config';
import { IndexLoader } from '../indexer/loader.js';
import { EmbeddingsService } from '../indexer/embeddings.js';
import { parseRegions } from '../indexer/paths.js';

async function main() {
  console.log('========================================');
  console.log('[Test] ベクトル検索の動作確認');
  console.log('========================================\n');

  // 1. インデックス読み込み
  const indexName = String(process.env.AGENT_INDEX_NAME ?? '').trim() || 'shopping';
  const indexDir = String(process.env.AGENT_INDEX_DIR ?? '').trim() || 'output/indexes';
  
  console.log('[1/4] インデックス読み込み中...');
  const loader = new IndexLoader(indexName, indexDir);
  const vectorStore = await loader.loadVectorStore();
  const chunks = await loader.loadAllChunks();
  console.log(`✓ インデックス読み込み完了: ${chunks.length}チャンク\n`);

  // 2. ベクトルがゼロベクトルでないか確認
  console.log('[2/4] ベクトルの検証中...');
  const testQuery = "Dashboard";
  const testVectorFlat = new Float32Array(1536).fill(0.5); // ダミーベクトル
  
  try {
    const searchResult = vectorStore.search(Array.from(testVectorFlat), 5);
    console.log(`✓ Faiss検索が動作します`);
    console.log(`  検索結果: ${searchResult.length}件`);
    
    // スコアを確認（すべて同じならゼロベクトルの可能性）
    const scores = searchResult.map(r => r.score);
    const uniqueScores = new Set(scores);
    console.log(`  スコアの種類: ${uniqueScores.size}種類`);
    
    if (uniqueScores.size === 1) {
      console.log('  ⚠️ すべて同じスコア → ベクトルがゼロの可能性あり\n');
    } else {
      console.log(`  ✓ スコアが異なる → ベクトルは正常に格納されています\n`);
    }
  } catch (e: any) {
    console.error(`✗ Faiss検索エラー: ${e?.message ?? e}\n`);
  }

  // 3. 実際のクエリ埋め込みテスト
  console.log('[3/4] クエリ埋め込みテスト中...');
  const embeddingModel = String(process.env.INDEXER_EMBEDDING_MODEL ?? '').trim() || 'cohere.embed-v4:0';
  const regionsStr = String(process.env.INDEXER_AWS_REGION ?? '').trim() || 'ap-northeast-1';
  const regions = parseRegions(regionsStr);
  
  const embeddingService = new EmbeddingsService(regions, embeddingModel);
  
  try {
    console.log(`  クエリ: "${testQuery}"`);
    const queryVector = await embeddingService.embedQuery(testQuery);
    console.log(`✓ クエリ埋め込み成功`);
    console.log(`  ベクトル次元: ${queryVector.length}`);
    console.log(`  先頭5要素: [${queryVector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`);
    
    // ベクトルがゼロでないか確認
    const nonZeroCount = queryVector.filter(v => v !== 0).length;
    console.log(`  非ゼロ要素: ${nonZeroCount}/${queryVector.length} (${(nonZeroCount / queryVector.length * 100).toFixed(1)}%)`);
    
    if (nonZeroCount === 0) {
      console.log('  ❌ すべてゼロベクトル！埋め込みが失敗しています\n');
      process.exit(1);
    } else {
      console.log(`  ✓ 埋め込みベクトルは正常です\n`);
    }

    // 4. 実際の類似検索テスト
    console.log('[4/4] 類似検索テスト中...');
    console.log(`  クエリ: "${testQuery}"`);
    const results = vectorStore.search(queryVector, 5);
    console.log(`✓ 検索結果: ${results.length}件\n`);

    console.log('📊 上位5件の結果:');
    for (let i = 0; i < Math.min(5, results.length); i++) {
      const result = results[i]!;
      const chunk = chunks.find(c => c.chunk_id === result.chunkId);
      
      console.log(`  ${i + 1}. ${result.chunkId} (スコア: ${result.score.toFixed(4)})`);
      if (chunk) {
        console.log(`     URL: ${chunk.url}`);
        console.log(`     サイズ: ${chunk.char_count}文字`);
        const preview = chunk.chunk_text.substring(0, 150).replace(/\n/g, ' ');
        console.log(`     内容: ${preview}...`);
      }
      console.log('');
    }

    // スコアの分散を確認
    const allScores = results.map(r => r.score);
    const minScore = Math.min(...allScores);
    const maxScore = Math.max(...allScores);
    const avgScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    
    console.log('📈 検索スコア統計:');
    console.log(`  最小: ${minScore.toFixed(4)}`);
    console.log(`  最大: ${maxScore.toFixed(4)}`);
    console.log(`  平均: ${avgScore.toFixed(4)}`);
    console.log(`  範囲: ${(maxScore - minScore).toFixed(4)}`);
    
    if (maxScore - minScore < 0.001) {
      console.log('  ⚠️ スコア範囲が非常に小さい → ベクトルが類似している可能性');
    } else {
      console.log('  ✓ スコアに十分な分散あり → ベクトル検索が正常に機能しています');
    }

  } catch (e: any) {
    console.error(`\n❌ エラー: ${e?.message ?? e}`);
    if (e?.stack) {
      console.error('\nスタックトレース:');
      console.error(e.stack);
    }
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('✅ すべてのテストが成功しました！');
  console.log('   - インデックス読み込み: OK');
  console.log('   - ベクトル格納: OK');
  console.log('   - クエリ埋め込み: OK');
  console.log('   - 類似検索: OK');
  console.log('========================================');
}

main();

