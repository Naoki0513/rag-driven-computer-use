/**
 * チャンクメタデータの型定義
 */
export interface ChunkMetadata {
  chunk_id: string;           // 例: "page_123_chunk_5"
  page_id: number;            // pages.id への参照
  url: string;                // ページURL
  site: string;               // サイトドメイン
  chunk_index: number;        // ページ内での順序 (0始まり)
  chunk_text: string;         // チャンク本文
  char_count: number;         // 文字数
  created_at: string;         // インデックス作成日時（ISO8601）
  snapshot_hash: string;      // 元のスナップショットハッシュ（更新検知用）
}

/**
 * ページデータの型定義（CSV読み込み用）
 */
export interface PageRecord {
  id?: number;
  URL?: string;
  site?: string;
  snapshotforai?: string;
  'snapshotfor AI'?: string;  // 後方互換
  'snapshotin MD'?: string;
  timestamp?: string;
  depth?: number;
  [key: string]: any;
}

/**
 * 埋め込みベクトルの型定義
 */
export interface EmbeddingVector {
  chunk_id: string;
  vector: number[];
}

/**
 * インデクサー設定
 */
export interface IndexerConfig {
  csvPath: string;
  indexName: string;           // インデックス名（例: "shopping"）
  outputDir: string;           // 出力ディレクトリ（例: "output/indexes"）
  embeddingModel: string;
  regions: string[];           // リージョンリスト（フォールバック用）
  maxChunkSize: number;
  minChunkSize: number;
  batchSize: number;
}

/**
 * インデックスファイルパスのヘルパー
 */
export interface IndexPaths {
  chunksPath: string;          // chunks.parquet
  vectorsPath: string;         // vectors.faiss
  mappingPath: string;         // vectors.faiss.mapping.json
  indexDir: string;            // インデックスディレクトリ
}

