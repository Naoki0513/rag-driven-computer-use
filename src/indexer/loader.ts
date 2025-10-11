import parquet from 'parquetjs';
import { VectorStore } from './vector-store.js';
import { getIndexPaths } from './paths.js';
import type { ChunkMetadata } from './types.js';

/**
 * インデックスローダー（Agent用）
 * インデックス名を指定するだけで3ファイル全部を読み込む
 */
export class IndexLoader {
  private indexName: string;
  private baseDir: string;
  private paths: ReturnType<typeof getIndexPaths>;
  
  constructor(indexName: string, baseDir: string = 'output/indexes') {
    this.indexName = indexName;
    this.baseDir = baseDir;
    this.paths = getIndexPaths(indexName, baseDir);
  }

  /**
   * ベクトルストアを読み込み
   */
  async loadVectorStore(): Promise<VectorStore> {
    console.log(`[IndexLoader] ベクトルストア読み込み: ${this.indexName}`);
    return await VectorStore.load(this.paths.vectorsPath);
  }

  /**
   * チャンクメタデータを読み込み（全件）
   */
  async loadAllChunks(): Promise<ChunkMetadata[]> {
    console.log(`[IndexLoader] チャンクメタデータ読み込み: ${this.indexName}`);
    
    const reader = await parquet.ParquetReader.openFile(this.paths.chunksPath);
    const cursor = reader.getCursor();
    
    const chunks: ChunkMetadata[] = [];
    let row = await cursor.next();
    
    while (row) {
      chunks.push(row as ChunkMetadata);
      row = await cursor.next();
    }
    
    await reader.close();
    console.log(`[IndexLoader] ✓ ${chunks.length}チャンク読み込み完了`);
    
    return chunks;
  }

  /**
   * チャンクIDでメタデータを検索
   */
  async findChunksByIds(chunkIds: string[]): Promise<Map<string, ChunkMetadata>> {
    const allChunks = await this.loadAllChunks();
    const chunkMap = new Map<string, ChunkMetadata>();
    
    for (const chunk of allChunks) {
      if (chunkIds.includes(chunk.chunk_id)) {
        chunkMap.set(chunk.chunk_id, chunk);
      }
    }
    
    return chunkMap;
  }

  /**
   * インデックス情報を取得
   */
  getInfo() {
    return {
      indexName: this.indexName,
      baseDir: this.baseDir,
      paths: this.paths
    };
  }
}

/**
 * 環境変数からインデックスローダーを作成
 */
export function createIndexLoaderFromEnv(): IndexLoader | null {
  const indexName = String(process.env.AGENT_INDEX_NAME ?? '').trim();
  const indexDir = String(process.env.AGENT_INDEX_DIR ?? '').trim() || 'output/indexes';
  
  if (!indexName) {
    console.log('[IndexLoader] AGENT_INDEX_NAME が未設定のため、インデックスローダーを作成しません');
    return null;
  }
  
  return new IndexLoader(indexName, indexDir);
}

