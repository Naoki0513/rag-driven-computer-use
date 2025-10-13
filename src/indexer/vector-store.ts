import faiss from 'faiss-node';
import { promises as fs } from 'fs';
import path from 'path';

const { IndexFlatIP } = faiss;

/**
 * Faissベクトルストアのラッパー
 */
export class VectorStore {
  private index: any;
  private dimension: number;
  private chunkIds: string[];

  constructor(dimension: number = 1536) {
    this.dimension = dimension;
    this.index = new IndexFlatIP(dimension);
    this.chunkIds = [];
  }

  /**
   * ベクトルを追加
   * @param vectors 埋め込みベクトル配列
   * @param chunkIds 対応するチャンクID配列
   */
  addVectors(vectors: number[][], chunkIds: string[]): void {
    if (vectors.length !== chunkIds.length) {
      throw new Error('ベクトル数とチャンクID数が一致しません');
    }

    // メモリ圧迫を避けるため、追加はチャンク分割して行う
    const addChunkSizeEnv = String(process.env.INDEXER_FAISS_ADD_CHUNK || '').trim();
    const ADD_CHUNK = Number.isFinite(Number(addChunkSizeEnv)) && Number(addChunkSizeEnv) > 0
      ? Math.trunc(Number(addChunkSizeEnv))
      : 256; // デフォルト: 256ベクトルずつ

    for (let start = 0; start < vectors.length; start += ADD_CHUNK) {
      const end = Math.min(start + ADD_CHUNK, vectors.length);
      const batchCount = end - start;
      // フラット化（number[]）。Float32ArrayにしてからArray.fromでもよいが、二重化を避けるため直接number[]にする
      const flat: number[] = new Array(batchCount * this.dimension);
      let cursor = 0;
      for (let i = start; i < end; i++) {
        const vector = vectors[i]!;
        if (vector.length !== this.dimension) {
          throw new Error(`ベクトル次元が一致しません: expected ${this.dimension}, got ${vector.length}`);
        }
        for (let d = 0; d < this.dimension; d++) {
          flat[cursor++] = vector[d]!;
        }
        this.chunkIds.push(chunkIds[i]!);
      }
      // faiss-nodeは通常の配列(number[])を期待
      (this.index as any).add(flat);
    }
  }

  /**
   * 類似検索
   * @param queryVector クエリベクトル
   * @param k 上位k件
   * @returns チャンクIDとスコアの配列
   */
  search(queryVector: number[], k: number): Array<{ chunkId: string; score: number; index: number }> {
    if (queryVector.length !== this.dimension) {
      throw new Error(`クエリベクトル次元が一致しません: expected ${this.dimension}, got ${queryVector.length}`);
    }

    // faiss-nodeのsearchは通常の配列を期待
    const result = (this.index as any).search(queryVector, k);

    const results: Array<{ chunkId: string; score: number; index: number }> = [];
    for (let i = 0; i < result.labels.length; i++) {
      const idx = result.labels[i]!;
      const score = result.distances[i]!;
      const chunkId = this.chunkIds[idx];
      if (chunkId) {
        results.push({ chunkId, score, index: idx });
      }
    }

    return results;
  }

  /**
   * インデックスをファイルに保存
   */
  async save(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Faissインデックスを保存
    this.index.write(filePath);

    // チャンクIDマッピングを別ファイルに保存
    const mappingPath = filePath + '.mapping.json';
    await fs.writeFile(
      mappingPath,
      JSON.stringify({ chunkIds: this.chunkIds, dimension: this.dimension }, null, 2),
      'utf-8'
    );

    console.log(`[VectorStore] インデックス保存: ${filePath}`);
    console.log(`[VectorStore] マッピング保存: ${mappingPath}`);
    console.log(`[VectorStore] 総ベクトル数: ${this.chunkIds.length}`);
  }

  /**
   * インデックスをファイルから読み込み
   */
  static async load(filePath: string): Promise<VectorStore> {
    const mappingPath = filePath + '.mapping.json';
    
    // マッピングを読み込み
    const mappingContent = await fs.readFile(mappingPath, 'utf-8');
    const mapping = JSON.parse(mappingContent) as { chunkIds: string[]; dimension: number };

    // Faissインデックスを読み込み
    const index = IndexFlatIP.read(filePath);
    
    const store = new VectorStore(mapping.dimension);
    store.index = index;
    store.chunkIds = mapping.chunkIds;

    console.log(`[VectorStore] インデックス読み込み: ${filePath}`);
    console.log(`[VectorStore] 総ベクトル数: ${store.chunkIds.length}`);

    return store;
  }

  /**
   * インデックスのベクトル数を取得
   */
  getSize(): number {
    return this.chunkIds.length;
  }
}

