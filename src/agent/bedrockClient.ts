import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ToolConfiguration,
  type ConverseResponse,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { addCachePoints, type Message } from './cacheUtils.js';
import { runCypher, executeWorkflow, type ToolUseInput } from './tools.js';

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
          name: 'execute_workflow',
          description:
            'JSON形式のワークフローを入力として受け取り、Playwright APIを使ってブラウザを操作し、各ステップを直列に実行。目標達成したら終了。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                workflow: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      action: { type: 'string' },
                      url: { type: 'string' },
                      name: { type: 'string' },
                      role: { type: 'string' },
                      text: { type: 'string' },
                      key: { type: 'string' },
                    },
                  },
                },
              },
              required: ['workflow'],
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
    const cmd = new ConverseCommand({
      modelId,
      system,
      toolConfig,
      messages: currentMessages as any,
      inferenceConfig: { maxTokens: 4096, temperature: 0.5 },
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
      for (const block of assistantMsg?.content ?? []) {
        if (!block.toolUse) continue;
        const toolUse = block.toolUse as ToolUseInput;
        const name = toolUse.name;
        const toolUseId = (toolUse as any).toolUseId as string;
        if (name === 'run_cypher') {
          const q = (toolUse as any).input?.query ?? '';
          const result = await runCypher(String(q));
          toolResults.push({ toolResult: { toolUseId, content: [{ text: result }], status: 'success' } });
        } else if (name === 'execute_workflow') {
          const wf = (toolUse as any).input?.workflow ?? [];
          const result = await executeWorkflow(wf);
          toolResults.push({ toolResult: { toolUseId, content: [{ text: result }], status: 'success' } });
        }
      }
      if (toolResults.length) messages.push({ role: 'user', content: toolResults });
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


