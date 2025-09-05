import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseResponse,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { addCachePoints, type Message } from './cacheUtils.js';
import { buildToolConfig } from './tool-config.js';
import { runCypher } from './tools/run-cypher.js';
import { searchByKeywords } from './tools/run-cypher.js';
import { browserLogin } from './tools/browser-login.js';
import { browserGoto } from './tools/browser-goto.js';
import { browserClick } from './tools/browser-click.js';
import { browserInput } from './tools/browser-input.js';
import { browserPress } from './tools/browser-press.js';
import { browserFlow } from './tools/browser-flow.js';
import type { ToolUseInput } from './tools/types.js';
import { recordBedrockCallStart, recordBedrockCallSuccess, recordBedrockCallError, flushObservability } from '../utilities/observability.js';

export type ConverseLoopResult = {
  fullText: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

// リージョンのスロットリング健康状態（単純なクールダウン）
const regionThrottleUntil = new Map<string, number>();
function isRegionCoolingDown(region: string): boolean {
  const until = regionThrottleUntil.get(region) ?? 0;
  return Date.now() < until;
}
function markRegionThrottled(region: string): void {
  const ms = Math.max(1, Math.trunc(Number(process.env.AGENT_REGION_THROTTLE_COOLDOWN_MS || 15000)));
  regionThrottleUntil.set(region, Date.now() + ms);
}
function clearRegionThrottle(region: string): void {
  regionThrottleUntil.delete(region);
}

export async function converseLoop(
  query: string,
  systemPrompt: string,
  candidates: Array<{ modelId: string; region: string }>,
): Promise<ConverseLoopResult> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('モデル候補が空です');
  }
  const anyClaude = candidates.some((c) => c.modelId.toLowerCase().includes('claude'));
  const anyNova = candidates.some((c) => c.modelId.toLowerCase().includes('nova'));

  const toolConfig = buildToolConfig();
  const system: SystemContentBlock[] = [{ text: systemPrompt } as SystemContentBlock];
  if (anyClaude) {
    system.push({ cachePoint: { type: 'default' } } as unknown as SystemContentBlock);
  }
  const messages: Message[] = [{ role: 'user', content: [{ text: query }] }];

  // リージョン順序（候補の出現順で重複排除）とリージョン→候補の対応
  const regionOrder: string[] = [];
  for (const c of candidates) {
    if (!regionOrder.includes(c.region)) regionOrder.push(c.region);
  }
  if (regionOrder.length === 0) throw new Error('リージョン候補が空です');
  const regionToCandidates = new Map<string, Array<{ modelId: string; region: string }>>();
  for (const r of regionOrder) regionToCandidates.set(r, []);
  for (const c of candidates) {
    const list = regionToCandidates.get(c.region);
    if (list) list.push(c);
  }
  // 失敗するまで同一リージョンを使い続けるためのインデックス
  let activeRegionIndex = 0;
  console.log(`[Region Router] 初期アクティブリージョン: ${regionOrder[activeRegionIndex]}（順序: ${regionOrder.join(' -> ')}）`);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let fullText = '';

  while (true) {
    const currentMessages = addCachePoints(messages, anyClaude, anyNova);
    let response: ConverseResponse | undefined;
    let lastError: any;

    // 現在のアクティブリージョンから順に直列で試行し、成功リージョンを固定
    for (let step = 0; step < regionOrder.length; step += 1) {
      const regionIndex = (activeRegionIndex + step) % regionOrder.length;
      const region = regionOrder[regionIndex]!;
      const regionCandidates = regionToCandidates.get(region) ?? [];
      if (!regionCandidates.length) continue;
      console.log(`[PerTurn Sequential] 試行リージョン ${step + 1}/${regionOrder.length}: region=${region}`);

      for (let i = 0; i < regionCandidates.length; i += 1) {
        const { modelId } = regionCandidates[i]!;
        console.log(`[Region Attempt] model=${modelId}, region=${region}`);
        const client = new BedrockRuntimeClient({ region });
        const lowerId = modelId.toLowerCase();

        const additionalModelRequestFields: Record<string, any> = {};
        const betaTags: string[] = [];
        if (modelId === 'us.anthropic.claude-sonnet-4-20250514-v1:0') {
          betaTags.push(process.env.AGENT_ANTHROPIC_BETA ?? 'context-1m-2025-08-07');
        }
        if (lowerId.includes('anthropic.claude-3-7-sonnet-20250219')) {
          betaTags.push('token-efficient-tools-2025-02-19');
        }
        if (betaTags.length) additionalModelRequestFields['anthropic_beta'] = betaTags;

        const cmd = new ConverseCommand({
          modelId,
          system,
          toolConfig,
          messages: currentMessages as any,
          inferenceConfig: { maxTokens: 4096, temperature: 0.5 },
          additionalModelRequestFields,
        });
        if (Object.keys(additionalModelRequestFields).length) {
          console.log(`[Debug] additionalModelRequestFields: ${JSON.stringify(additionalModelRequestFields)}`);
        }
        const obsHandle = recordBedrockCallStart({
          modelId,
          region,
          input: {
            system,
            toolConfig,
            messages: currentMessages,
            inferenceConfig: { maxTokens: 4096, temperature: 0.5 },
            additionalModelRequestFields,
          },
        });

        try {
          const res = await client.send(cmd);
          try {
            const usage = (res as any)?.usage ?? undefined;
            const out: any = (res as any)?.output;
            let textOut: string | undefined = undefined;
            const content = out?.message?.content ?? [];
            for (const block of content) if (block?.text) textOut = (textOut ?? '') + block.text;
            const payload: any = { usage, response: res };
            if (typeof textOut === 'string') payload.outputText = textOut;
            recordBedrockCallSuccess(obsHandle, payload);
          } catch {}
          response = res;
          if (activeRegionIndex !== regionIndex) {
            console.log(`[Region Router] アクティブリージョンを更新: ${regionOrder[activeRegionIndex]} -> ${region}`);
          }
          activeRegionIndex = regionIndex;
          break;
        } catch (e: any) {
          try { recordBedrockCallError(obsHandle, e, { modelId, region }); } catch {}
          lastError = e;
          const msg = String(e?.name || e?.message || e || '');
          console.log(`[Region Attempt] 失敗 model=${modelId} region=${region} msg=${msg}`);
          continue;
        }
      }

      if (response) break; // このリージョンで成功
      console.log(`[PerTurn Sequential] リージョン失敗: ${region} → 次リージョンへフェイルオーバー`);
    }

    if (!response) throw lastError ?? new Error('No response from Bedrock');

    const usage = response.usage ?? ({} as any);
    totalInput += usage.inputTokens ?? 0;
    totalOutput += usage.outputTokens ?? 0;
    totalCacheRead += usage.cacheReadInputTokens ?? 0;
    totalCacheWrite += usage.cacheWriteInputTokens ?? 0;

    const stopReason = response.stopReason as string | undefined;
    const out = response.output as any;
    if (stopReason === 'end_turn') {
      const content = out?.message?.content ?? [];
      for (const block of content) if (block.text) fullText += block.text;
      break;
    }
    if (stopReason === 'tool_use') {
      const assistantMsg = out?.message;
      messages.push({ role: 'assistant', content: assistantMsg?.content ?? [] });

      const toolResults: any[] = [];

      // 受け取った tool_use を並列実行可能なものと順次実行が必要なものに仕分け
      type Task = { index: number; toolUseId: string; run: () => Promise<string> };
      const browserTasks: Task[] = [];
      const parallelTasks: Task[] = [];

      const contentBlocks = assistantMsg?.content ?? [];
      for (let i = 0; i < contentBlocks.length; i += 1) {
        const block = contentBlocks[i]!;
        if (!block.toolUse) continue;
        const toolUse = block.toolUse as ToolUseInput;
        const name = toolUse.name;
        const toolUseId = (toolUse as any).toolUseId as string;
        if (name === 'run_cypher') {
          const q = (toolUse as any).input?.query ?? '';
          parallelTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: run_cypher with input: ${JSON.stringify({ query: q })}`);
            const result = await runCypher(String(q));
            console.log(`Tool result (run_cypher): ${result}`);
            return result;
          }});
        } else if (name === 'search_by_keywords') {
          const keywords = (toolUse as any).input?.keywords ?? [];
          parallelTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: search_by_keywords with input: ${JSON.stringify({ keywords })}`);
            const result = await searchByKeywords(Array.isArray(keywords) ? keywords : []);
            console.log(`Tool result (search_by_keywords): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_login') {
          const url = (toolUse as any).input?.url ?? '';
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_login ${JSON.stringify({ url })}`);
            const result = await browserLogin(String(url));
            console.log(`Tool result (browser_login): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_goto') {
          const targetId = Number((toolUse as any).input?.targetId ?? 0);
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_goto ${JSON.stringify({ targetId })}`);
            const result = await browserGoto(Number(targetId));
            console.log(`Tool result (browser_goto): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_click') {
          const ref = (toolUse as any).input?.ref ?? '';
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_click ${JSON.stringify({ ref })}`);
            const result = await browserClick(String(ref));
            console.log(`Tool result (browser_click): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_input') {
          const ref = (toolUse as any).input?.ref ?? '';
          const text = (toolUse as any).input?.text ?? '';
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_input ${JSON.stringify({ ref, text })}`);
            const result = await browserInput(String(ref), String(text));
            console.log(`Tool result (browser_input): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_press') {
          const ref = (toolUse as any).input?.ref ?? '';
          const key = (toolUse as any).input?.key ?? '';
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_press ${JSON.stringify({ ref, key })}`);
            const result = await browserPress(String(ref), String(key));
            console.log(`Tool result (browser_press): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_flow') {
          const flowInput = (toolUse as any).input ?? {};
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_flow ${JSON.stringify(flowInput).slice(0, 500)}${JSON.stringify(flowInput).length > 500 ? '...' : ''}`);
            const result = await browserFlow(flowInput);
            console.log(`Tool result (browser_flow): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        }
      }

      // 並列実行（DBクエリなどブラウザ非依存）: 例外は文字列化して返す
      const parallelResults = await Promise.all(parallelTasks.map(async (t) => {
        try {
          const text = await t.run();
          return { index: t.index, toolUseId: t.toolUseId, text };
        } catch (e: any) {
          const err = `エラー: ${String(e?.message ?? e)}`;
          return { index: t.index, toolUseId: t.toolUseId, text: err };
        }
      }));

      // ブラウザ操作は順次実行（順序保証・状態共有のため）
      const browserResults: Array<{ index: number; toolUseId: string; text: string }> = [];
      const orderedBrowserTasks = [...browserTasks].sort((a, b) => a.index - b.index);
      for (const t of orderedBrowserTasks) {
        try {
          const text = await t.run();
          browserResults.push({ index: t.index, toolUseId: t.toolUseId, text });
        } catch (e: any) {
          const err = `エラー: ${String(e?.message ?? e)}`;
          browserResults.push({ index: t.index, toolUseId: t.toolUseId, text: err });
        }
      }

      // 元の順序にマージ
      const merged = [...parallelResults, ...browserResults].sort((a, b) => a.index - b.index);
      for (const r of merged) {
        toolResults.push({ toolResult: { toolUseId: r.toolUseId, content: [{ text: r.text }], status: 'success' } });
      }
      if (toolResults.length) {
        console.log(`Adding tool results to messages: ${JSON.stringify(toolResults)}`);
        messages.push({ role: 'user', content: toolResults });
      }
      continue;
    }
    if (stopReason === 'max_tokens') {
      fullText += '\n[注意] 最大トークン数に達しました。応答が途切れている可能性があります。';
      break;
    }
    throw new Error(`未知のstopReason: ${stopReason}`);
  }

  try { await flushObservability(); } catch {}
  return { fullText, usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite } };
}




