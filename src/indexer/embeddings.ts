import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export class EmbeddingsService {
  private regions: string[];
  private activeRegionIndex: number;
  private modelId: string;
  
  constructor(regions: string[], modelId: string) {
    if (!regions.length) {
      throw new Error('リージョンリストが空です');
    }
    this.regions = regions;
    this.activeRegionIndex = 0;
    this.modelId = modelId;
    
    console.log('\n========================================');
    console.log('[EmbeddingsService] リージョン設定');
    console.log('========================================');
    console.log(`利用可能リージョン数: ${regions.length}`);
    console.log(`初期アクティブリージョン: ${regions[0]}`);
    console.log(`フォールオーバー順序: ${regions.join(' -> ')}`);
    console.log('========================================\n');
  }
  
  private getClient(): BedrockRuntimeClient {
    const region = this.regions[this.activeRegionIndex];
    if (!region) {
      throw new Error('アクティブリージョンが取得できませんでした');
    }
    return new BedrockRuntimeClient({ region });
  }

  /**
   * テキストを埋め込みベクトルに変換
   * @param texts テキスト配列
   * @returns 埋め込みベクトル配列（各ベクトルは1536次元 - Cohere Embed v4）
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    
    const results: number[][] = [];
    
    for (const text of texts) {
      try {
        const vector = await this.embedSingleText(text);
        results.push(vector);
      } catch (e: any) {
        console.error(`[Embeddings] エラー（テキスト長: ${text.length}）: ${e?.message ?? e}`);
        // エラー時はゼロベクトルで埋める（インデックスの整合性維持）
        results.push(new Array(1536).fill(0));
      }
    }
    
    return results;
  }

  /**
   * 単一テキストを埋め込む（リージョンフォールバック付き）
   */
  private async embedSingleText(text: string): Promise<number[]> {
    // Cohere Embed v4の入力形式（https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html）
    const body = JSON.stringify({
      texts: [text],
      input_type: 'search_document',  // インデックス作成時は search_document
      embedding_types: ['float'],
      truncate: 'RIGHT'  // 長すぎる場合は末尾を切る
    });

    const bodyBuffer = Buffer.from(body, 'utf-8');
    let lastError: any;

    // アクティブリージョンから順に試行
    for (let step = 0; step < this.regions.length; step++) {
      const regionIndex = (this.activeRegionIndex + step) % this.regions.length;
      const region = this.regions[regionIndex]!;
      const client = new BedrockRuntimeClient({ region });

      const command = new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: '*/*',
        body: bodyBuffer
      });

      try {
        const response = await client.send(command);
        const responseBody = JSON.parse(Buffer.from(response.body!).toString('utf-8'));
        
        // Cohere Embed v4のレスポンス形式
        let embeddings: number[][] | undefined;
        
        if (responseBody?.response_type === 'embeddings_floats') {
          embeddings = responseBody.embeddings;
        } else if (responseBody?.response_type === 'embeddings_by_type') {
          embeddings = responseBody?.embeddings?.float;
        } else {
          embeddings = responseBody?.embeddings?.float || responseBody?.embeddings;
        }
        
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          throw new Error('埋め込みベクトルが取得できませんでした');
        }

        // 成功したらアクティブリージョンを更新
        if (this.activeRegionIndex !== regionIndex) {
          console.log(`[EmbeddingsService] ✅ リージョン切り替え: ${this.regions[this.activeRegionIndex]} -> ${region}`);
          this.activeRegionIndex = regionIndex;
        }
        
        return embeddings[0] as number[];
      } catch (e: any) {
        lastError = e;
        const errorName = String(e?.name || 'UnknownError');
        const errorMsg = String(e?.message || e || '');
        
        // ThrottlingException の場合は短い待機を挟む
        if (errorName === 'ThrottlingException' || errorMsg.toLowerCase().includes('throttl') || errorMsg.toLowerCase().includes('too many')) {
          if (step < this.regions.length - 1) {
            const waitMs = 1000 + Math.random() * 2000; // 1-3秒のランダムな待機
            console.log(`[EmbeddingsService] ${region}でレート制限: ${Math.round(waitMs)}ms待機後、次のリージョンへ`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
        }
        
        // 次のリージョンへフォールオーバー
        if (step < this.regions.length - 1) {
          console.log(`[EmbeddingsService] ${region}で失敗 (${errorName}): 次のリージョンへフォールオーバー`);
        }
        continue;
      }
    }

    // すべてのリージョンで失敗
    throw lastError ?? new Error('すべてのリージョンで埋め込みに失敗しました');
  }

  /**
   * クエリテキストを埋め込む（検索時用、リージョンフォールバック付き）
   */
  async embedQuery(text: string): Promise<number[]> {
    const body = JSON.stringify({
      texts: [text],
      input_type: 'search_query',  // 検索時は search_query
      embedding_types: ['float'],
      truncate: 'RIGHT'
    });

    const bodyBuffer = Buffer.from(body, 'utf-8');
    let lastError: any;

    // アクティブリージョンから順に試行
    for (let step = 0; step < this.regions.length; step++) {
      const regionIndex = (this.activeRegionIndex + step) % this.regions.length;
      const region = this.regions[regionIndex]!;
      const client = new BedrockRuntimeClient({ region });

      const command = new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: '*/*',
        body: bodyBuffer
      });

      try {
        const response = await client.send(command);
        const responseBody = JSON.parse(Buffer.from(response.body!).toString('utf-8'));
        
        // Cohere Embed v4のレスポンス形式
        let embeddings: number[][] | undefined;
        
        if (responseBody?.response_type === 'embeddings_floats') {
          embeddings = responseBody.embeddings;
        } else if (responseBody?.response_type === 'embeddings_by_type') {
          embeddings = responseBody?.embeddings?.float;
        } else {
          embeddings = responseBody?.embeddings?.float || responseBody?.embeddings;
        }
        
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          throw new Error('クエリの埋め込みベクトルが取得できませんでした');
        }

        // 成功したらアクティブリージョンを更新
        if (this.activeRegionIndex !== regionIndex) {
          console.log(`[EmbeddingsService] ✅ リージョン切り替え: ${this.regions[this.activeRegionIndex]} -> ${region}`);
          this.activeRegionIndex = regionIndex;
        }
        
        return embeddings[0] as number[];
      } catch (e: any) {
        lastError = e;
        const errorName = String(e?.name || 'UnknownError');
        const errorMsg = String(e?.message || e || '');
        
        if (errorName === 'ThrottlingException' || errorMsg.toLowerCase().includes('throttl') || errorMsg.toLowerCase().includes('too many')) {
          if (step < this.regions.length - 1) {
            const waitMs = 1000 + Math.random() * 2000;
            console.log(`[EmbeddingsService] ${region}でレート制限: ${Math.round(waitMs)}ms待機後、次のリージョンへ`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
        }
        
        if (step < this.regions.length - 1) {
          console.log(`[EmbeddingsService] ${region}で失敗 (${errorName}): 次のリージョンへフォールオーバー`);
        }
        continue;
      }
    }

    throw lastError ?? new Error('すべてのリージョンでクエリ埋め込みに失敗しました');
  }
}

