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
    this.embeddingService = new EmbeddingsService(config.regions, config.embeddingModel);
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
    console.log('[3/4] 埋め込み処理中（Bedrock API呼び出し）...');
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
      const snapshotText = (page['snapshotforai'] ?? page['snapshotfor AI'] ?? '') as string;
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
      let snapshotText = (page['snapshotforai'] ?? page['snapshotfor AI'] ?? '') as string;
      
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
   * チャンクを埋め込む（100チャンクごとにバッチ並列処理）
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

    // 100チャンクごとにバッチ処理
    for (let i = 0; i < chunks.length; i += this.config.batchSize) {
      const batch = chunks.slice(i, Math.min(i + this.config.batchSize, chunks.length));
      
      // バッチ内は並列処理
      const batchPromises = batch.map(async (chunk) => {
        try {
          const vector = await this.embeddingService.embedTexts([chunk.chunk_text]);
          progressBar.update(++completed);
          return { vector: vector[0]!, chunkId: chunk.chunk_id, success: true };
        } catch (e: any) {
          progressBar.update(++completed);
          console.error(`\n[Embeddings] エラー（chunk_id: ${chunk.chunk_id}）: ${e?.message ?? e}`);
          // エラー時はゼロベクトルで埋める
          return { vector: new Array(1536).fill(0), chunkId: chunk.chunk_id, success: false };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      allResults.push(...batchResults);
    }

    progressBar.stop();

    const vectors = allResults.map(r => r.vector);
    const chunkIds = allResults.map(r => r.chunkId);
    const successCount = allResults.filter(r => r.success).length;
    
    console.log(`  ✓ 成功: ${successCount}/${chunks.length} チャンク`);
    if (successCount < chunks.length) {
      console.log(`  ⚠ 失敗: ${chunks.length - successCount} チャンク（ゼロベクトルで埋めました）`);
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

