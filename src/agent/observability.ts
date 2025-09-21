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

export function recordBedrockCallSuccess(handle: BedrockCallHandle, payload: { outputText?: string; usage?: any; response?: any }): void {
  try {
    const gen: any = handle?.generation;
    if (!gen) return;
    const meta: Record<string, any> = {};
    try {
      if (payload?.response?.ResponseMetadata) meta.ResponseMetadata = payload.response.ResponseMetadata;
    } catch {}
    if (typeof payload?.outputText === 'string') meta.outputText = payload.outputText;
    const body = {
      output: payload.response ?? null,
      usage: payload.usage ?? undefined,
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



