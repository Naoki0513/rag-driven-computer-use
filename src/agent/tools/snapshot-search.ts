import { attachTodos, formatToolError, rerankPlainTextDocuments } from './util.js';
import { createIndexLoaderFromEnv } from '../../indexer/loader.js';
import { EmbeddingsService } from '../../indexer/embeddings.js';
import type { ChunkMetadata } from '../../indexer/types.js';
import { recordVectorSearchCallStart, recordVectorSearchCallSuccess, recordVectorSearchCallError, recordVectorSearchUsage } from '../observability.js';

function splitKeywords(input: string): string[] {
  return String(input || '')
    .toLowerCase()
    .split(/[，、,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeKeywords(input: any): string[] {
  try {
    const fromArray = Array.isArray(input?.keywords)
      ? (input.keywords as any[])
          .map((s) => String(s ?? '').toLowerCase().trim())
          .filter((s) => s.length > 0)
      : [];
    if (fromArray.length) return fromArray;
    const legacy = String(input?.keywordQuery || '').trim();
    if (legacy) return splitKeywords(legacy);
  } catch {}
  return [];
}

export async function snapshotSearch(input: { keywords: string[]; vectorQuery: string; topK?: number }): Promise<string> {
  try {
    const vectorQuery = String((input as any)?.vectorQuery || '').trim();
    const topKInput = Math.trunc(Number((input as any)?.topK));
    const terms = normalizeKeywords(input as any);
    const hasKeywordsArray = Array.isArray((input as any)?.keywords);
    
    if (!vectorQuery || (!hasKeywordsArray && !String((input as any)?.keywordQuery || '').trim())) {
      const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: 'エラー: keywords と vectorQuery は必須です（keywordQuery は後方互換として解釈されます）' });
      return JSON.stringify(payload);
    }

    const t0 = Date.now();
    
    // インデックスローダーを作成
    const indexLoader = createIndexLoaderFromEnv();
    if (!indexLoader) {
      const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: 'エラー: AGENT_INDEX_NAME が未設定です。インデックスを使用するには環境変数を設定してください。' });
      return JSON.stringify(payload);
    }

    // 1) Parquetからチャンクメタデータを全件読み込み
    console.info(`[snapshot_search] チャンクメタデータを読み込み中...`);
    const allChunks = await indexLoader.loadAllChunks();
    console.info(`[snapshot_search] 総チャンク数: ${allChunks.length}`);

    if (!allChunks.length) {
      const payload = await attachTodos({ ok: true, action: 'snapshot_search', results: [] });
      return JSON.stringify(payload);
    }

    // 2) キーワードAND検索で絞り込み（keywords 配列による厳密 AND 検索。未指定/空配列の場合は全件）
    const keywordFiltered: ChunkMetadata[] = terms.length
      ? allChunks.filter((chunk) => {
          const lc = chunk.chunk_text.toLowerCase();
          // AND検索: すべてのキーワードが含まれる必要がある
          for (const kw of terms) {
            if (!lc.includes(kw)) return false;
          }
          return true;
        })
      : allChunks;
    
    console.info(`[snapshot_search] keywords(AND) terms=${JSON.stringify(terms)} matchedChunks=${keywordFiltered.length}/${allChunks.length}`);

    if (!keywordFiltered.length) {
      const payload = await attachTodos({ ok: true, action: 'snapshot_search', results: [], note: 'キーワード検索で一致するチャンクが見つかりませんでした（keywordsを減らす/一般化するなど条件緩和を検討してください）' });
      return JSON.stringify(payload);
    }

    // 3) ベクトル検索の準備
    const envDefaultTop = Number(process.env.AGENT_SEARCH_TOP_K);
    const defaultTop = Number.isFinite(envDefaultTop) && envDefaultTop > 0 ? envDefaultTop : 10;
    const requestedTop = Number.isFinite(topKInput) && topKInput > 0 ? topKInput : defaultTop;
    const vectorSearchK = Math.min(requestedTop * 10, keywordFiltered.length); // topK×10件
    
    console.info(`[snapshot_search] ベクトル検索: topK=${requestedTop}, vectorSearchK=${vectorSearchK}`);

    // Embedding Serviceの初期化
    const embeddingModel = String(process.env.AGENT_EMBEDDING_MODEL || '').trim() || 'cohere.embed-v4:0';
    const regionsStr = String(process.env.AGENT_AWS_REGION || '').trim() || 'ap-northeast-1';
    const providerStr = String(process.env.AGENT_EMBEDDING_PROVIDER || '').trim() || 'bedrock';
    const regions = regionsStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
    const provider = (providerStr === 'cohere-api' || providerStr === 'bedrock') ? providerStr as 'bedrock' | 'cohere-api' : 'bedrock';
    
    const embeddingService = new EmbeddingsService(regions, embeddingModel, provider);

    // クエリをベクトル化（Langfuseに記録）
    console.info(`[snapshot_search] クエリをベクトル化中: "${vectorQuery}"`);
    const vectorSearchHandle = recordVectorSearchCallStart({
      modelId: embeddingModel,
      provider,
      input: {
        query: vectorQuery,
        keywordFilteredChunks: keywordFiltered.length,
        requestedTopK: requestedTop
      },
      name: 'Vector Search (Embed + Search)'
    });
    
    let queryVector: number[];
    try {
      queryVector = await embeddingService.embedQuery(vectorQuery);
      // 使用量を記録（クエリ文字数 + フィルタ済みドキュメント数）
      try { recordVectorSearchUsage(vectorSearchHandle, vectorQuery.length, keywordFiltered.length); } catch {}
    } catch (e: any) {
      recordVectorSearchCallError(vectorSearchHandle, e, { stage: 'embed_query', modelId: embeddingModel, provider });
      throw e;
    }

    // ベクトルストアを読み込み
    console.info(`[snapshot_search] ベクトルストアを読み込み中...`);
    const vectorStore = await indexLoader.loadVectorStore();

    // キーワードフィルタリングされたチャンクのchunk_idを取得
    const filteredChunkIds = new Set(keywordFiltered.map(c => c.chunk_id));

    // 4) ベクトル検索を実行（全ベクトルから検索し、後でフィルタリング）
    // 十分な数を取得するために、vectorSearchK * 2 を検索して後でフィルタリング
    const expandedK = Math.min(vectorSearchK * 2, vectorStore.getSize());
    console.info(`[snapshot_search] ベクトル検索実行: expandedK=${expandedK}`);
    const vectorResults = vectorStore.search(queryVector, expandedK);

    // キーワードフィルタリングされたチャンクのみを残す
    const filteredVectorResults = vectorResults
      .filter(r => filteredChunkIds.has(r.chunkId))
      .slice(0, vectorSearchK);

    console.info(`[snapshot_search] ベクトル検索結果: ${filteredVectorResults.length}件`);
    
    // ベクトル検索成功を記録
    recordVectorSearchCallSuccess(vectorSearchHandle, {
      resultsCount: filteredVectorResults.length,
      metadata: {
        expandedK,
        vectorSearchK,
        keywordFilteredChunks: keywordFiltered.length,
        finalVectorResults: filteredVectorResults.length
      }
    });

    if (!filteredVectorResults.length) {
      const payload = await attachTodos({ ok: true, action: 'snapshot_search', results: [], note: 'ベクトル検索で結果が得られませんでした' });
      return JSON.stringify(payload);
    }

    // チャンクIDからメタデータを取得
    const chunkMap = await indexLoader.findChunksByIds(filteredVectorResults.map(r => r.chunkId));

    // 5) リランク用のドキュメントを準備
    const rerankDocs = filteredVectorResults
      .map(r => {
        const chunk = chunkMap.get(r.chunkId);
        if (!chunk) return null;
        return { text: `${chunk.url}\n\n${chunk.chunk_text}`, chunkId: r.chunkId };
      })
      .filter(Boolean) as Array<{ text: string; chunkId: string }>;

    console.info(`[snapshot_search] リランク実行: ${rerankDocs.length}ドキュメント → topK=${requestedTop}`);
    
    // 6) リランクで最終結果を取得
    const reranked = await rerankPlainTextDocuments(
      vectorQuery, 
      rerankDocs.map(d => d.text), 
      { topK: requestedTop, category: 'search', name: 'Snapshot Search (Vector)' }
    );

    const top = reranked.slice(0, requestedTop).map((r) => {
      const doc = rerankDocs[r.index];
      if (!doc) return null;
      const chunk = chunkMap.get(doc.chunkId);
      if (!chunk) return null;
      return { 
        id: String(chunk.page_id), 
        url: chunk.url, 
        chunk: chunk.chunk_text 
      };
    }).filter(Boolean) as Array<{ id: string; url: string; chunk: string }>;

    const ms = Date.now() - t0;
    console.info(`[snapshot_search] 完了: ${top.length}件返却, 処理時間=${ms}ms`);
    console.info(`[snapshot_search] 統計: totalChunks=${allChunks.length}, keywordFiltered=${keywordFiltered.length}, vectorSearchResults=${filteredVectorResults.length}, finalResults=${top.length}`);

    const payload = await attachTodos({ 
      ok: true, 
      action: 'snapshot_search', 
      results: top
    });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ ok: false, action: 'snapshot_search', error: formatToolError(e) });
    return JSON.stringify(payload);
  }
}


