import { Langfuse } from 'langfuse';

let _langfuse: Langfuse | null = null;
let _currentTrace: any | null = null;

function initLangfuseIfPossible(): Langfuse | null {
  if (_langfuse) return _langfuse;
  const publicKey = String(process.env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = String(process.env.LANGFUSE_SECRET_KEY || '').trim();
  const baseUrl = String(process.env.LANGFUSE_HOST || '').trim();
  if (!publicKey || !secretKey || !baseUrl) return null;
  try {
    _langfuse = new Langfuse({ publicKey, secretKey, baseUrl });
  } catch {
    _langfuse = null;
  }
  return _langfuse;
}

export type BedrockCallContext = {
  modelId: string;
  region?: string;
  input: Record<string, any>;
};

export type BedrockCallHandle = {
  generation?: any;
};

export function startSessionTrace(sessionId: string, traceName?: string, metadata?: Record<string, any>): void {
  try {
    const client = initLangfuseIfPossible() as any;
    if (!client) return;
    const body: any = { sessionId };
    if (traceName) body.name = traceName;
    if (metadata) body.metadata = metadata;
    _currentTrace = client.trace(body);
  } catch {
    _currentTrace = null;
  }
}

export function recordBedrockCallStart(ctx: BedrockCallContext): BedrockCallHandle {
  try {
    const client = initLangfuseIfPossible();
    if (!client) return {};
    let gen: any = null;
    if (_currentTrace && typeof _currentTrace.generation === 'function') {
      gen = _currentTrace.generation({
        name: 'Bedrock Converse',
        model: ctx.modelId,
        input: ctx.input,
        metadata: { region: ctx.region },
      });
    } else {
      gen = (client as any).generation({
        name: 'Bedrock Converse',
        model: ctx.modelId,
        input: ctx.input,
        metadata: { region: ctx.region },
      });
    }
    return { generation: gen };
  } catch (_e) {
    return {};
  }
}

export function recordBedrockCallSuccess(handle: BedrockCallHandle, payload: { outputText?: string; usage?: any; response?: any; thinking?: string }): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const meta: Record<string, any> = {};
    try {
      if (payload?.response?.ResponseMetadata) meta.ResponseMetadata = payload.response.ResponseMetadata;
    } catch {}
    if (typeof payload?.outputText === 'string') meta.outputText = payload.outputText;
    if (typeof (payload as any)?.thinking === 'string') meta.thinking = (payload as any).thinking;

    // ===== Bedrock usage → Langfuse usageDetails へのマッピング =====
    function toInt(n: any): number | undefined {
      const v = Math.trunc(Number(n));
      return Number.isFinite(v) && v >= 0 ? v : undefined;
    }

    function mapBedrockUsageToUsageDetails(u: any): Record<string, number> | undefined {
      if (!u || typeof u !== 'object') return undefined;
      const input = toInt((u as any).inputTokens);
      const output = toInt((u as any).outputTokens);
      const cacheReadA = toInt((u as any).cacheReadInputTokens);
      const cacheReadB = toInt((u as any).cacheReadInputTokenCount);
      const cacheWriteA = toInt((u as any).cacheWriteInputTokens);
      const cacheWriteB = toInt((u as any).cacheWriteInputTokenCount);
      const total = toInt((u as any).totalTokens);
      const usageDetails: Record<string, number> = {};
      if (typeof input === 'number') usageDetails.inputTokens = input;
      if (typeof output === 'number') usageDetails.outputTokens = output;
      const cacheRead = typeof cacheReadB === 'number' ? cacheReadB : cacheReadA;
      const cacheWrite = typeof cacheWriteB === 'number' ? cacheWriteB : cacheWriteA;
      if (typeof cacheRead === 'number') usageDetails.cacheReadInputTokenCount = cacheRead;
      if (typeof cacheWrite === 'number') usageDetails.cacheWriteInputTokenCount = cacheWrite;
      if (typeof total === 'number') usageDetails.totalTokens = total;
      // totalTokens が無い場合は合算で補完
      if (usageDetails.totalTokens === undefined) {
        let sum = 0;
        let has = false;
        for (const k of Object.keys(usageDetails)) {
          if (k === 'totalTokens') continue;
          sum += usageDetails[k]!;
          has = true;
        }
        if (has) usageDetails.totalTokens = sum;
      }
      return Object.keys(usageDetails).length ? usageDetails : undefined;
    }

    function computeCostDetails(usageDetails?: Record<string, number>): Record<string, number> | undefined {
      if (!usageDetails) return undefined;
      function priceOrDefault(envKey: string, d: number): number {
        const v = Number(process.env[envKey]);
        return Number.isFinite(v) && v >= 0 ? v : d;
      }
      // 既定単価（1トークンあたりUSD）: ユーザー指定
      const pInput = priceOrDefault('AGENT_LANGFUSE_COST_INPUT_PER_TOKEN', 0.00000300);
      const pOutput = priceOrDefault('AGENT_LANGFUSE_COST_OUTPUT_PER_TOKEN', 0.00001500);
      const pCacheRead = priceOrDefault('AGENT_LANGFUSE_COST_CACHE_READ_INPUT_PER_TOKEN', 0.00000030);
      const pCacheWrite = priceOrDefault('AGENT_LANGFUSE_COST_CACHE_WRITE_INPUT_PER_TOKEN', 0.00000375);
      const costs: Record<string, number> = {};
      if (typeof usageDetails.inputTokens === 'number') costs.inputTokens = usageDetails.inputTokens * pInput;
      if (typeof usageDetails.outputTokens === 'number') costs.outputTokens = usageDetails.outputTokens * pOutput;
      if (typeof usageDetails.cacheReadInputTokenCount === 'number') costs.cacheReadInputTokenCount = usageDetails.cacheReadInputTokenCount * pCacheRead;
      if (typeof usageDetails.cacheWriteInputTokenCount === 'number') costs.cacheWriteInputTokenCount = usageDetails.cacheWriteInputTokenCount * pCacheWrite;
      if (Object.keys(costs).length) {
        const total = Object.values(costs).reduce((a, b) => a + b, 0);
        costs.total = total;
        return costs;
      }
      return undefined;
    }

    const usageDetails = mapBedrockUsageToUsageDetails(payload?.usage);
    const costDetails = computeCostDetails(usageDetails);

    const body = {
      output: payload.response ?? null,
      // 互換: tracing SDK 形式（推奨）
      usageDetails: usageDetails ?? undefined,
      costDetails: costDetails ?? undefined,
      // 後方互換: 主要値も usage に複製（キーは従来の input/output/total）
      usage: usageDetails
        ? {
            input: usageDetails.inputTokens,
            output: usageDetails.outputTokens,
            total: usageDetails.totalTokens,
          }
        : undefined,
      metadata: Object.keys(meta).length ? meta : undefined,
    } as any;
    if (typeof gen.end === 'function') gen.end(body);
    else if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}

export function recordBedrockCallError(handle: BedrockCallHandle, error: unknown, extra?: Record<string, any>): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const errorMessage = String((error as any)?.message ?? error);
    const body = {
      level: 'ERROR',
      status_message: errorMessage,
      metadata: extra,
    } as any;
    if (typeof gen.end === 'function') gen.end(body);
    else if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}

export async function flushObservability(): Promise<void> {
  try {
    const client = initLangfuseIfPossible() as any;
    if (!client) return;
    if (typeof client.flushAsync === 'function') await client.flushAsync();
    if (typeof client.shutdownAsync === 'function') await client.shutdownAsync();
  } catch {
  }
}


// ===== Rerank (Cohere via Bedrock Agent Runtime) 計測 =====
export type RerankCallContext = {
  modelArn: string;
  region?: string;
  input: Record<string, any>;
  name?: string; // 任意の表示名（例: "URL Rerank" / "Snapshot Rerank"）
};

export type RerankCallHandle = {
  generation?: any;
};

export function recordRerankCallStart(ctx: RerankCallContext): RerankCallHandle {
  try {
    const client = initLangfuseIfPossible();
    if (!client) return {};
    const displayName = ctx.name || 'Bedrock Rerank';
    let gen: any = null;
    if (_currentTrace && typeof _currentTrace.generation === 'function') {
      gen = _currentTrace.generation({
        name: displayName,
        model: ctx.modelArn,
        input: ctx.input,
        metadata: { region: ctx.region },
      });
    } else {
      gen = (client as any).generation({
        name: displayName,
        model: ctx.modelArn,
        input: ctx.input,
        metadata: { region: ctx.region },
      });
    }
    return { generation: gen };
  } catch (_e) {
    return {};
  }
}

export function recordRerankCallSuccess(handle: RerankCallHandle, payload: { response?: any; resultsSummary?: any; metadata?: Record<string, any> }): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const body = {
      output: payload.response ?? null,
      metadata: payload.metadata ? { ...payload.metadata, resultsSummary: payload.resultsSummary } : { resultsSummary: payload.resultsSummary },
    } as any;
    if (typeof gen.end === 'function') gen.end(body);
    else if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}

export function recordRerankCallError(handle: RerankCallHandle, error: unknown, extra?: Record<string, any>): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const errorMessage = String((error as any)?.message ?? error);
    const body = {
      level: 'ERROR',
      status_message: errorMessage,
      metadata: extra,
    } as any;
    if (typeof gen.end === 'function') gen.end(body);
    else if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}

// Rerank 用: ドキュメント数から算出したトークンを usageDetails として即時送信
// 100 ドキュメントあたり 1 トークン、切り上げ（0 件なら 0 トークン）
export function recordRerankUsage(handle: RerankCallHandle, documentsCount: number): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const n = Math.max(0, Math.trunc(Number(documentsCount || 0)));
    const tokens = n === 0 ? 0 : Math.ceil(n / 100);
    const body = { usageDetails: { input: tokens, total: tokens } } as any;
    if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}

// ===== Vector Search (Cohere Embed v4) 計測 =====
export type VectorSearchCallContext = {
  modelId: string;
  provider: string;
  input: Record<string, any>;
  name?: string; // 任意の表示名（例: "Vector Search"）
};

export type VectorSearchCallHandle = {
  generation?: any;
};

export function recordVectorSearchCallStart(ctx: VectorSearchCallContext): VectorSearchCallHandle {
  try {
    const client = initLangfuseIfPossible();
    if (!client) return {};
    const displayName = ctx.name || 'Vector Search';
    let gen: any = null;
    if (_currentTrace && typeof _currentTrace.generation === 'function') {
      gen = _currentTrace.generation({
        name: displayName,
        model: ctx.modelId,
        input: ctx.input,
        metadata: { provider: ctx.provider },
      });
    } else {
      gen = (client as any).generation({
        name: displayName,
        model: ctx.modelId,
        input: ctx.input,
        metadata: { provider: ctx.provider },
      });
    }
    return { generation: gen };
  } catch (_e) {
    return {};
  }
}

export function recordVectorSearchCallSuccess(handle: VectorSearchCallHandle, payload: { resultsCount?: number; metadata?: Record<string, any> }): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const body = {
      output: { resultsCount: payload.resultsCount },
      metadata: payload.metadata,
    } as any;
    if (typeof gen.end === 'function') gen.end(body);
    else if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}

export function recordVectorSearchCallError(handle: VectorSearchCallHandle, error: unknown, extra?: Record<string, any>): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const errorMessage = String((error as any)?.message ?? error);
    const body = {
      level: 'ERROR',
      status_message: errorMessage,
      metadata: extra,
    } as any;
    if (typeof gen.end === 'function') gen.end(body);
    else if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}

// Vector Search 用: クエリトークン推定（簡易）
export function recordVectorSearchUsage(handle: VectorSearchCallHandle, queryLength: number, documentsCount: number): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    // 簡易推定: クエリ文字数を4で割ってトークン数とする + ドキュメント数/100
    const queryTokens = Math.ceil(queryLength / 4);
    const docTokens = Math.ceil(documentsCount / 100);
    const total = queryTokens + docTokens;
    const body = { usageDetails: { input: total, total } } as any;
    if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
  }
}



