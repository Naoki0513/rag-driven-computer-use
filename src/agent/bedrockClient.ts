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
    if (isClaude) {
      // Anthropic Beta: Context 1M (configurable via env, default provided)
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
      for (const block of assistantMsg?.content ?? []) {
        if (!block.toolUse) continue;
        const toolUse = block.toolUse as ToolUseInput;
        const name = toolUse.name;
        const toolUseId = (toolUse as any).toolUseId as string;
        if (name === 'run_cypher') {
          const q = (toolUse as any).input?.query ?? '';
          console.log(`Calling tool: run_cypher with input: ${JSON.stringify({ query: q })}`);
          const result = await runCypher(String(q));
          console.log(`Tool result (run_cypher): ${result}`);
          toolResults.push({ toolResult: { toolUseId, content: [{ text: result }], status: 'success' } });
        } else if (name === 'execute_workflow') {
          const wf = (toolUse as any).input?.workflow ?? [];
          console.log(`Executing workflow: ${JSON.stringify(wf, null, 2)}`);
          const result = await executeWorkflow(wf);
          console.log(`Tool result (execute_workflow): ${result.substring(0, 1000)}${result.length > 1000 ? '...': ''}`);
          toolResults.push({ toolResult: { toolUseId, content: [{ text: result }], status: 'success' } });
        }
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


