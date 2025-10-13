import { promises as fs } from 'fs';
import path from 'path';
import cliProgress from 'cli-progress';
import parquet from 'parquetjs';
import { EmbeddingsService } from './embeddings.js';
import { VectorStore } from './vector-store.js';
import { chunkSnapshotText } from '../agent/tools/util.js';
import { computeSha256Hex } from '../utilities/text.js';
import type { ChunkMetadata, PageRecord, IndexerConfig } from './types.js';
import { getIndexPaths } from './paths.js';

export class IndexerProcessor {
  private config: IndexerConfig;
  private embeddingService: EmbeddingsService;
  private paths: ReturnType<typeof getIndexPaths>;

  constructor(config: IndexerConfig) {
    this.config = config;
    this.embeddingService = new EmbeddingsService(config.regions, config.embeddingModel, config.provider);
    this.paths = getIndexPaths(config.indexName, config.outputDir);
  }

  /**
   * メイン処理: CSVを読み込み、チャンク化、埋め込み、保存
   */
  async process(): Promise<void> {
    console.log('\n========================================');
    console.log('[Indexer] 処理開始');
    console.log('========================================');
    console.log(`インデックス名: ${this.config.indexName}`);
    console.log(`出力ディレクトリ: ${this.paths.indexDir}`);
    console.log(`入力CSV: ${this.config.csvPath}`);
    console.log(`  - チャンクメタデータ: ${this.paths.chunksPath}`);
    console.log(`  - ベクトルインデックス: ${this.paths.vectorsPath}`);
    console.log(`  - マッピング: ${this.paths.mappingPath}`);
    console.log(`埋め込みモデル: ${this.config.embeddingModel}`);
    console.log(`リージョン: ${this.config.regions.join(', ')}`);
    console.log('========================================\n');

    // 1. CSVを読み込み
    console.log('[1/4] CSVを読み込み中...');
    const pages = await this.loadCsvPages();
    console.log(`✓ 読み込み完了: ${pages.length} ページ\n`);

    // 2. チャンク分割
    console.log('[2/4] スナップショットをチャンク分割中...');
    const chunks = await this.createChunks(pages);
    console.log(`✓ チャンク分割完了: ${chunks.length} チャンク\n`);

    // 3. 埋め込み処理
    console.log('[3/4] 埋め込み処理中...');
    const { vectors, chunkIds } = await this.embedChunks(chunks);
    console.log(`✓ 埋め込み完了: ${vectors.length} ベクトル\n`);

    // 4. 保存
    console.log('[4/4] 保存中...');
    await this.saveChunksParquet(chunks);
    await this.saveVectorsFaiss(vectors, chunkIds);
    console.log('✓ 保存完了\n');

    console.log('========================================');
    console.log('[Indexer] 処理完了');
    console.log('========================================');
  }

  /**
   * CSVからページデータを読み込み
   */
  private async loadCsvPages(): Promise<PageRecord[]> {
    const csvContent = await fs.readFile(this.config.csvPath, 'utf-8');
    const lines = csvContent.trim().split('\n');
    
    if (lines.length < 2) {
      throw new Error('CSVファイルが空です');
    }

    // ヘッダー行をパース
    const header = lines[0]!.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    
    // データ行をパース（簡易的なCSVパーサー、quoted fieldsに対応）
    const pages: PageRecord[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      
      const record: PageRecord = {};
      const values = this.parseCsvLine(line);
      
      for (let j = 0; j < header.length; j++) {
        const key = header[j]!;
        const value = values[j] ?? '';
        
        if (key === 'id' || key === 'depth') {
          record[key] = parseInt(value, 10);
        } else {
          record[key] = value;
        }
      }
      
      pages.push(record);
    }

    return pages;
  }

  /**
   * CSVの1行をパース（quoted fieldsに対応）
   */
  private parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    
    values.push(current.trim().replace(/^"|"$/g, ''));
    return values;
  }

  /**
   * ページをチャンクに分割
   */
  private async createChunks(pages: PageRecord[]): Promise<ChunkMetadata[]> {
    const chunks: ChunkMetadata[] = [];
    
    // 事前にスナップショットサイズを確認
    console.log('\n[チャンク分割前] 各ページのスナップショットサイズ:');
    pages.forEach((page, idx) => {
      const snapshotText = (page['snapshotforai'] ?? '') as string;
      console.log(`  Page ${page.id ?? idx + 1}: ${snapshotText.length}文字`);
    });
    console.log(`\n設定: MAX=${this.config.maxChunkSize}文字, MIN=${this.config.minChunkSize}文字\n`);
    
    const progressBar = new cliProgress.SingleBar({
      format: '進捗 [{bar}] {percentage}% | {value}/{total} ページ',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });

    progressBar.start(pages.length, 0);

    for (const page of pages) {
      const pageId = page.id ?? 0;
      const url = page.URL ?? '';
      const site = page.site ?? '';
      // 列名は snapshotforai（スペースなし）
      let snapshotText = (page['snapshotforai'] ?? '') as string;
      
      // CSVからの読み込みでエスケープされた改行を実際の改行に変換
      snapshotText = snapshotText
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      
      const snapshotHash = computeSha256Hex(snapshotText);

      if (!snapshotText || snapshotText.trim().length === 0) {
        progressBar.increment();
        continue;
      }

      // チャンク分割（既存のロジックを再利用）
      const chunkTexts = chunkSnapshotText(
        snapshotText,
        this.config.maxChunkSize,
        this.config.minChunkSize
      );

      // デバッグ出力：各ページのチャンク分割結果
      if (chunkTexts.length > 1) {
        const sizes = chunkTexts.map(ct => ct.length);
        const avgSize = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
        console.log(`  Page ${pageId}: ${snapshotText.length}文字 → ${chunkTexts.length}チャンク (平均: ${avgSize}文字, 範囲: ${Math.min(...sizes)}-${Math.max(...sizes)}文字)`);
      }

      for (let i = 0; i < chunkTexts.length; i++) {
        const chunkText = chunkTexts[i]!;
        chunks.push({
          chunk_id: `page_${pageId}_chunk_${i}`,
          page_id: pageId,
          url,
          site,
          chunk_index: i,
          chunk_text: chunkText,
          char_count: chunkText.length,
          created_at: new Date().toISOString(),
          snapshot_hash: snapshotHash
        });
      }

      progressBar.increment();
    }

    progressBar.stop();
    return chunks;
  }

  /**
   * チャンクを埋め込む（バッチ一括処理、最大96個ずつAPI呼び出し）
   */
  private async embedChunks(chunks: ChunkMetadata[]): Promise<{ vectors: number[][]; chunkIds: string[] }> {
    const progressBar = new cliProgress.SingleBar({
      format: '進捗 [{bar}] {percentage}% | {value}/{total} チャンク',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });

    progressBar.start(chunks.length, 0);
    let completed = 0;

    const allResults: Array<{ vector: number[]; chunkId: string; success: boolean }> = [];

    // API制限: 最大96テキスト/リクエスト
    const API_MAX_BATCH_SIZE = 96;
    
    const totalApiCalls = Math.ceil(chunks.length / API_MAX_BATCH_SIZE);
    
    console.log(`\n[Embeddings] API制限対応: 最大${API_MAX_BATCH_SIZE}テキスト/リクエスト`);
    console.log(`[Embeddings] 推定API呼び出し回数: ${totalApiCalls}回\n`);

    // 96件単位のサブバッチを全体から作成
    const subBatches: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < chunks.length; i += API_MAX_BATCH_SIZE) {
      subBatches.push({ start: i, end: Math.min(i + API_MAX_BATCH_SIZE, chunks.length) });
    }

    const totalSubBatches = subBatches.length;
    const concurrency = Math.max(1, this.config.concurrency ?? 1);
    console.log(`[Embeddings] サブバッチ総数: ${totalSubBatches} / 並列実行数: ${concurrency}`);

    // 並列実行プール
    let currentIndex = 0;
    const runWorker = async (workerId: number) => {
      while (currentIndex < subBatches.length) {
        const myIndex = currentIndex++;
        const { start, end } = subBatches[myIndex]!;
        const subBatch = chunks.slice(start, end);
        try {
          const subBatchTexts = subBatch.map(c => c.chunk_text);
          const vectors = await this.embeddingService.embedTexts(subBatchTexts);
          for (let k = 0; k < subBatch.length; k++) {
            const chunk = subBatch[k]!;
            const vector = vectors[k]!;
            const isZeroVector = vector.every(v => v === 0);
            if (isZeroVector) {
              console.log(`\n⚠️  [${chunk.chunk_id}] ゼロベクトルが返されました`);
              allResults.push({ vector, chunkId: chunk.chunk_id, success: false });
            } else {
              allResults.push({ vector, chunkId: chunk.chunk_id, success: true });
            }
            progressBar.update(++completed);
          }
        } catch (e: any) {
          console.error(`\n❌ サブバッチ ${myIndex + 1}/${totalSubBatches} エラー（${subBatch.length}チャンク）: ${e?.message ?? e}`);
          for (const chunk of subBatch) {
            allResults.push({ vector: new Array(1536).fill(0), chunkId: chunk.chunk_id, success: false });
            progressBar.update(++completed);
          }
        }
      }
    };

    // ワーカー起動
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(runWorker(w));
    }
    await Promise.all(workers);

    progressBar.stop();

    const vectors = allResults.map(r => r.vector);
    const chunkIds = allResults.map(r => r.chunkId);
    const successCount = allResults.filter(r => r.success).length;
    
    console.log(`\n  ✓ 成功: ${successCount}/${chunks.length} チャンク`);
    if (successCount < chunks.length) {
      console.log(`  ❌ 失敗: ${chunks.length - successCount} チャンク（ゼロベクトルで埋めました）`);
      console.log(`  ⚠️  警告: 失敗したチャンクはベクトル検索で機能しません\n`);
    }

    return { vectors, chunkIds };
  }

  /**
   * チャンクメタデータをParquetとして保存
   */
  private async saveChunksParquet(chunks: ChunkMetadata[]): Promise<void> {
    // インデックスディレクトリを作成
    await fs.mkdir(this.paths.indexDir, { recursive: true });

    // Parquetスキーマ定義
    const schema = new parquet.ParquetSchema({
      chunk_id: { type: 'UTF8' },
      page_id: { type: 'INT32' },
      url: { type: 'UTF8' },
      site: { type: 'UTF8' },
      chunk_index: { type: 'INT32' },
      chunk_text: { type: 'UTF8' },
      char_count: { type: 'INT32' },
      created_at: { type: 'UTF8' },
      snapshot_hash: { type: 'UTF8' }
    });

    // Parquetライター作成
    const writer = await parquet.ParquetWriter.openFile(schema, this.paths.chunksPath);

    // データ書き込み
    for (const chunk of chunks) {
      await writer.appendRow(chunk);
    }

    await writer.close();

    console.log(`  - チャンクメタデータ保存: ${this.paths.chunksPath}`);
    console.log(`  - 総チャンク数: ${chunks.length}`);
  }

  /**
   * ベクトルをFaissとして保存
   */
  private async saveVectorsFaiss(vectors: number[][], chunkIds: string[]): Promise<void> {
    const vectorStore = new VectorStore(1536);  // Cohere Embed v4は1536次元
    vectorStore.addVectors(vectors, chunkIds);
    await vectorStore.save(this.paths.vectorsPath);
  }
}

