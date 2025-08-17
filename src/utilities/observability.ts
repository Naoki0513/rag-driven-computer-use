/*
  Langfuse 観測ユーティリティ（安全な no-op 実装）
  - 環境変数未設定時は初期化しない
*/
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
    const body = {
      output: payload.outputText ?? payload.response ?? null,
      usage: payload.usage ?? undefined,
      metadata: payload.response ? { ResponseMetadata: payload.response?.ResponseMetadata } : undefined,
    };
    if (typeof gen.end === 'function') gen.end(body);
    else if (typeof gen.update === 'function') gen.update(body);
  } catch (_e) {
    // no-op
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
    // no-op
  }
}

export async function flushObservability(): Promise<void> {
  try {
    const client = initLangfuseIfPossible() as any;
    if (!client) return;
    if (typeof client.flushAsync === 'function') await client.flushAsync();
    if (typeof client.shutdownAsync === 'function') await client.shutdownAsync();
  } catch {
    // no-op
  }
}


