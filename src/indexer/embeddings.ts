import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

type EmbeddingProvider = 'bedrock' | 'cohere-api';

export class EmbeddingsService {
  private regions: string[];
  private activeRegionIndex: number;
  private modelId: string;
  private provider: EmbeddingProvider;
  private cohereApiKey?: string;
  
  constructor(regions: string[], modelId: string, provider: EmbeddingProvider = 'bedrock') {
    this.provider = provider;
    
    if (provider === 'bedrock') {
      if (!regions.length) {
        throw new Error('リージョンリストが空です');
      }
      this.regions = regions;
      this.activeRegionIndex = 0;
      this.modelId = modelId;
      
      console.log('\n========================================');
      console.log('[EmbeddingsService] Bedrock設定');
      console.log('========================================');
      console.log(`利用可能リージョン数: ${regions.length}`);
      console.log(`初期アクティブリージョン: ${regions[0]}`);
      console.log(`フォールオーバー順序: ${regions.join(' -> ')}`);
      console.log('========================================\n');
    } else if (provider === 'cohere-api') {
      const apiKey = process.env.COHERE_API_KEY;
      if (!apiKey) {
        throw new Error('COHERE_API_KEYが設定されていません');
      }
      this.cohereApiKey = apiKey;
      this.regions = [];
      this.activeRegionIndex = 0;
      this.modelId = modelId || 'embed-v4.0';
      
      console.log('\n========================================');
      console.log('[EmbeddingsService] Cohere API設定');
      console.log('========================================');
      console.log(`モデル: ${this.modelId}`);
      console.log(`APIキー: ${this.cohereApiKey.substring(0, 8)}...`);
      console.log('========================================\n');
    } else {
      throw new Error(`不明なプロバイダー: ${provider}`);
    }
  }
  
  private getClient(): BedrockRuntimeClient {
    const region = this.regions[this.activeRegionIndex];
    if (!region) {
      throw new Error('アクティブリージョンが取得できませんでした');
    }
    return new BedrockRuntimeClient({ region });
  }

  /**
   * テキストを埋め込みベクトルに変換（複数テキストを一括処理）
   * @param texts テキスト配列（最大96個）
   * @returns 埋め込みベクトル配列（各ベクトルは1536次元 - Cohere Embed v4）
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    
    // Cohere APIは最大96テキストを一度に処理可能
    if (texts.length > 96) {
      throw new Error(`テキスト数が多すぎます: ${texts.length} (最大96)`);
    }
    
    try {
      if (this.provider === 'cohere-api') {
        return await this.embedMultipleTextsCohereApi(texts, 'search_document');
      } else {
        return await this.embedMultipleTextsBedrock(texts, 'search_document');
      }
    } catch (e: any) {
      console.error(`[Embeddings] バッチエラー（${texts.length}テキスト）: ${e?.message ?? e}`);
      // エラー時は全てゼロベクトルで埋める
      return texts.map(() => new Array(1536).fill(0));
    }
  }

  /**
   * 単一テキストを埋め込む（リージョンフォールバック付き）
   */
  private async embedSingleText(text: string): Promise<number[]> {
    if (this.provider === 'cohere-api') {
      return await this.embedSingleTextCohereApi(text, 'search_document');
    } else {
      return await this.embedSingleTextBedrock(text, 'search_document');
    }
  }

  /**
   * Cohere公式APIで複数テキストを一括埋め込み（最大96個、429エラー時自動リトライ）
   */
  private async embedMultipleTextsCohereApi(texts: string[], inputType: 'search_document' | 'search_query'): Promise<number[][]> {
    const requestBody = {
      texts: texts,
      model: this.modelId,
      input_type: inputType,
      embedding_types: ['float'],
      truncate: 'END'
    };

    // 最大2回試行（初回 + リトライ1回）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('https://api.cohere.com/v2/embed', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.cohereApiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          
          // 429エラーでminuteが含まれる場合のみリトライ
          if (response.status === 429 && errorText.toLowerCase().includes('minute')) {
            if (attempt === 0) {
              console.log(`\n⏳ [Cohere API] レート制限（1分あたり）検出: 60秒待機後リトライします...`);
              await new Promise(resolve => setTimeout(resolve, 60000)); // 60秒待機
              continue; // リトライ
            }
          }
          
          throw new Error(`Cohere API error (${response.status}): ${errorText}`);
        }

        const responseBody = await response.json();
        
        // Cohere公式APIのレスポンス形式: { embeddings: { float: [[...], [...], ...] } }
        const embeddings = responseBody?.embeddings?.float;
        
        if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
          throw new Error(`埋め込みベクトル数が不一致: 期待=${texts.length}, 取得=${embeddings?.length ?? 0}`);
        }
        
        // 全ベクトルが有効かチェック
        for (let i = 0; i < embeddings.length; i++) {
          const vector = embeddings[i] as number[];
          const isAllZero = vector.every(v => v === 0);
          if (isAllZero) {
            throw new Error(`無効な埋め込みベクトル（全て0）: インデックス=${i}`);
          }
        }
        
        return embeddings as number[][];
      } catch (e: any) {
        // 最後の試行でエラーが出た場合、またはリトライ対象外のエラーの場合は投げる
        if (attempt === 1 || !e.message.includes('Cohere API error (429)')) {
          throw new Error(`Cohere API埋め込みエラー: ${e?.message ?? e}`);
        }
        // それ以外（初回の429エラー）は次のループでリトライ
      }
    }
    
    throw new Error('Cohere API埋め込みエラー: 予期しないエラー');
  }

  /**
   * Cohere公式APIで単一テキストを埋め込む（429エラー時自動リトライ）
   */
  private async embedSingleTextCohereApi(text: string, inputType: 'search_document' | 'search_query'): Promise<number[]> {
    const requestBody = {
      texts: [text],
      model: this.modelId,
      input_type: inputType,
      embedding_types: ['float'],
      truncate: 'END'
    };

    // 最大2回試行（初回 + リトライ1回）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('https://api.cohere.com/v2/embed', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.cohereApiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          
          // 429エラーでminuteが含まれる場合のみリトライ
          if (response.status === 429 && errorText.toLowerCase().includes('minute')) {
            if (attempt === 0) {
              console.log(`\n⏳ [Cohere API] レート制限（1分あたり）検出: 60秒待機後リトライします...`);
              await new Promise(resolve => setTimeout(resolve, 60000)); // 60秒待機
              continue; // リトライ
            }
          }
          
          throw new Error(`Cohere API error (${response.status}): ${errorText}`);
        }

        const responseBody = await response.json();
        
        // Cohere公式APIのレスポンス形式: { embeddings: { float: [[...]] } }
        const embeddings = responseBody?.embeddings?.float;
        
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          throw new Error('埋め込みベクトルが取得できませんでした');
        }
        
        const vector = embeddings[0] as number[];
        
        // 全ての要素が0でないことを確認（有効な埋め込みベクトルかチェック）
        const isAllZero = vector.every(v => v === 0);
        if (isAllZero) {
          throw new Error('無効な埋め込みベクトル（全て0）が返されました');
        }
        
        return vector;
      } catch (e: any) {
        // 最後の試行でエラーが出た場合、またはリトライ対象外のエラーの場合は投げる
        if (attempt === 1 || !e.message.includes('Cohere API error (429)')) {
          throw new Error(`Cohere API埋め込みエラー: ${e?.message ?? e}`);
        }
        // それ以外（初回の429エラー）は次のループでリトライ
      }
    }
    
    throw new Error('Cohere API埋め込みエラー: 予期しないエラー');
  }

  /**
   * Bedrock APIで複数テキストを一括埋め込み（最大96個、レート制限時自動リトライ）
   */
  private async embedMultipleTextsBedrock(texts: string[], inputType: 'search_document' | 'search_query'): Promise<number[][]> {
    const body = JSON.stringify({
      texts: texts,
      input_type: inputType,
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

      // 各リージョンで最大2回試行（初回 + 1分待機リトライ）
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await client.send(command);
          const responseBody = JSON.parse(Buffer.from(response.body!).toString('utf-8'));
          
          // Bedrock Cohere Embed v4のレスポンス形式
          const embeddings = responseBody?.embeddings;
          
          if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
            throw new Error(`埋め込みベクトル数が不一致: 期待=${texts.length}, 取得=${embeddings?.length ?? 0}`);
          }

          // 全ベクトルが有効かチェック
          for (let i = 0; i < embeddings.length; i++) {
            const vector = embeddings[i] as number[];
            const isAllZero = vector.every(v => v === 0);
            if (isAllZero) {
              throw new Error(`無効な埋め込みベクトル（全て0）: インデックス=${i}`);
            }
          }

          // 成功したらアクティブリージョンを更新
          if (this.activeRegionIndex !== regionIndex) {
            console.log(`[EmbeddingsService] ✅ リージョン切り替え: ${this.regions[this.activeRegionIndex]} -> ${region}`);
            this.activeRegionIndex = regionIndex;
          }
          
          return embeddings as number[][];
        } catch (e: any) {
          lastError = e;
          const errorName = String(e?.name || 'UnknownError');
          const errorMsg = String(e?.message || e || '');
          
          // ThrottlingExceptionでminuteが含まれる場合は1分待機してリトライ
          const isThrottling = errorName === 'ThrottlingException' || errorMsg.toLowerCase().includes('throttl');
          const isPerMinute = errorMsg.toLowerCase().includes('minute');
          
          if (isThrottling && isPerMinute && attempt === 0) {
            console.log(`\n⏳ [Bedrock ${region}] レート制限（1分あたり）検出: 60秒待機後リトライします...`);
            await new Promise(resolve => setTimeout(resolve, 60000)); // 60秒待機
            continue; // リトライ
          }
          
          // 1分あたりでないレート制限の場合は短い待機で次のリージョンへ
          if (isThrottling && !isPerMinute) {
            if (step < this.regions.length - 1) {
              const waitMs = 1000 + Math.random() * 2000;
              console.log(`[EmbeddingsService] ${region}でレート制限: ${Math.round(waitMs)}ms待機後、次のリージョンへ`);
              await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            break; // 次のリージョンへ
          }
          
          // その他のエラーは次のリージョンへフォールオーバー
          if (attempt === 1) { // リトライ後も失敗
            if (step < this.regions.length - 1) {
              console.log(`[EmbeddingsService] ${region}で失敗 (${errorName}): 次のリージョンへフォールオーバー`);
            }
            break; // 次のリージョンへ
          }
        }
      }
    }

    throw lastError ?? new Error('すべてのリージョンで埋め込みに失敗しました');
  }

  /**
   * Bedrock APIで単一テキストを埋め込む
   */
  private async embedSingleTextBedrock(text: string, inputType: 'search_document' | 'search_query'): Promise<number[]> {
    const body = JSON.stringify({
      texts: [text],
      input_type: inputType,
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
        
        // Bedrock Cohere Embed v4のレスポンス形式
        const embeddings = responseBody?.embeddings;
        
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          throw new Error('埋め込みベクトルが取得できませんでした');
        }

        const vector = embeddings[0] as number[];
        
        // 全ての要素が0でないことを確認（有効な埋め込みベクトルかチェック）
        const isAllZero = vector.every(v => v === 0);
        if (isAllZero) {
          throw new Error('無効な埋め込みベクトル（全て0）が返されました');
        }

        // 成功したらアクティブリージョンを更新
        if (this.activeRegionIndex !== regionIndex) {
          console.log(`[EmbeddingsService] ✅ リージョン切り替え: ${this.regions[this.activeRegionIndex]} -> ${region}`);
          this.activeRegionIndex = regionIndex;
        }
        
        return vector;
      } catch (e: any) {
        lastError = e;
        const errorName = String(e?.name || 'UnknownError');
        const errorMsg = String(e?.message || e || '');
        
        // ThrottlingException の場合は短い待機を挟む
        if (errorName === 'ThrottlingException' || errorMsg.toLowerCase().includes('throttl') || errorMsg.toLowerCase().includes('too many')) {
          if (step < this.regions.length - 1) {
            const waitMs = 1000 + Math.random() * 2000;
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

    throw lastError ?? new Error('すべてのリージョンで埋め込みに失敗しました');
  }

  /**
   * クエリテキストを埋め込む（検索時用、リージョンフォールバック付き）
   */
  async embedQuery(text: string): Promise<number[]> {
    if (this.provider === 'cohere-api') {
      return await this.embedSingleTextCohereApi(text, 'search_query');
    } else {
      return await this.embedSingleTextBedrock(text, 'search_query');
    }
  }
}

