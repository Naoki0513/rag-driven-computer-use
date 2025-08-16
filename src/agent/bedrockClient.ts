import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ToolConfiguration,
  type ConverseResponse,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { addCachePoints, type Message } from './cacheUtils.js';
import { runCypher, browserGoto, browserClick, browserInput, browserPress, type ToolUseInput } from './tools.js';

export type ConverseLoopResult = {
  fullText: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

function buildToolConfig(): ToolConfiguration {
  return {
    tools: [
      {
        toolSpec: {
          name: 'run_cypher',
          description: 'Neo4jデータベースに対してCypherクエリを実行します',
          inputSchema: {
            json: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_goto',
          description: 'ブラウザで指定URLへ遷移します（実行後のARIA/Textスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_click',
          description: 'ref(eXX) で特定した要素をクリックします（実行後のARIA/Textスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' } },
              required: ['ref'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_input',
          description: 'ref(eXX) で特定した要素にテキストを入力します（実行後のARIA/Textスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' }, text: { type: 'string' } },
              required: ['ref', 'text'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_press',
          description: 'ref(eXX) で特定した要素に対してキーボード押下を送ります（実行後のARIA/Textスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' }, key: { type: 'string' } },
              required: ['ref', 'key'],
            },
          },
        },
      },
    ],
    toolChoice: { auto: {} },
  } as ToolConfiguration;
}
export async function converseLoop(
  query: string,
  systemPrompt: string,
  modelId: string,
  region: string,
): Promise<ConverseLoopResult> {
  const client = new BedrockRuntimeClient({ region });
  console.log(`[OK] AIモデルを初期化しました (region=${region}, model=${modelId})`);
  const lowerId = modelId.toLowerCase();
  const isClaude = lowerId.includes('claude');
  const isNova = lowerId.includes('nova');

  const toolConfig = buildToolConfig();
  const system: SystemContentBlock[] = [{ text: systemPrompt } as SystemContentBlock];
  if (isClaude) {
    system.push({ cachePoint: { type: 'default' } } as unknown as SystemContentBlock);
  }
  const messages: Message[] = [{ role: 'user', content: [{ text: query }] }];

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let fullText = '';

  while (true) {
    const currentMessages = addCachePoints(messages, isClaude, isNova);
    const additionalModelRequestFields: Record<string, any> = {};
    const enableAnthropicBeta = modelId === 'us.anthropic.claude-sonnet-4-20250514-v1:0';
    if (enableAnthropicBeta) {
      // Anthropic Beta: Context 1M (configurable via env, default provided). Only for the specific model.
      const betaTag = process.env.AGENT_ANTHROPIC_BETA ?? 'context-1m-2025-08-07';
      additionalModelRequestFields['anthropic_beta'] = [betaTag];
    }
    const cmd = new ConverseCommand({
      modelId,
      system,
      toolConfig,
      messages: currentMessages as any,
      inferenceConfig: { maxTokens: 4096, temperature: 0.5 },
      // Add provider-specific request headers/fields
      additionalModelRequestFields,
    });

    const maxRetries = 3;
    let attempt = 0;
    let response: ConverseResponse | undefined;
    let lastErr: any;
    while (attempt <= maxRetries) {
      try {
        response = await client.send(cmd);
        break;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.name || e?.message || e);
        if (!/Throttling/i.test(msg) || attempt === maxRetries) throw e;
        const backoffMs = Math.min(60000, 15000 * Math.pow(2, attempt));
        console.log(`Throttlingエラーが発生しました。${Math.round(backoffMs / 1000)}秒待機してリトライします... (試行 ${attempt + 1}/${maxRetries + 1})`);
        await new Promise((r) => setTimeout(r, backoffMs));
        attempt += 1;
      }
    }
    if (!response) throw lastErr ?? new Error('No response from Bedrock');

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
        } else if (name === 'browser_goto') {
          const url = (toolUse as any).input?.url ?? '';
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_goto ${JSON.stringify({ url })}`);
            const result = await browserGoto(String(url));
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
        }
      }

      // 並列実行（DBクエリなどブラウザ非依存）
      const parallelResults = await Promise.all(parallelTasks.map(async (t) => ({
        index: t.index,
        toolUseId: t.toolUseId,
        text: await t.run(),
      })));

      // ブラウザ操作は順序保証のため逐次実行
      const browserResults: Array<{ index: number; toolUseId: string; text: string }> = [];
      for (const t of browserTasks) {
        const text = await t.run();
        browserResults.push({ index: t.index, toolUseId: t.toolUseId, text });
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

  return { fullText, usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite } };
}


