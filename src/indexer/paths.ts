import path from 'path';
import type { IndexPaths } from './types.js';

/**
 * インデックス名からファイルパスを生成
 * @param indexName インデックス名（例: "shopping"）
 * @param baseDir ベースディレクトリ（デフォルト: "output/indexes"）
 */
export function getIndexPaths(indexName: string, baseDir: string = 'output/indexes'): IndexPaths {
  const indexDir = path.join(baseDir, indexName);
  
  return {
    chunksPath: path.join(indexDir, 'chunks.parquet'),
    vectorsPath: path.join(indexDir, 'vectors.faiss'),
    mappingPath: path.join(indexDir, 'vectors.faiss.mapping.json'),
    indexDir
  };
}

/**
 * リージョン文字列をパースしてリストに変換（重複排除・順序維持）
 */
export function parseRegions(regionString: string): string[] {
  const regions = regionString
    .split(',')
    .map(r => r.trim())
    .filter(r => r.length > 0);
  
  // 重複排除（順序維持）
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const r of regions) {
    if (!seen.has(r)) {
      seen.add(r);
      unique.push(r);
    }
  }
  
  return unique;
}

