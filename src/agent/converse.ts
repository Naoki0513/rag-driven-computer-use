import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseResponse,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { addCachePoints, type Message } from './cacheUtils.js';
import { buildToolConfig } from './tool-config.js';
import { browserLogin } from './tools/browser-login.js';
import { browserGoto } from './tools/browser-goto.js';
import { browserClick } from './tools/browser-click.js';
import { browserInput } from './tools/browser-input.js';
import { browserPress } from './tools/browser-press.js';
import { browserSnapshot } from './tools/browser-snapshot.js';
import { todoTool } from './tools/todo.js';
import { snapshotSearch } from './tools/snapshot-search.js';
import { snapshotFetch } from './tools/snapshot-fetch.js';
import type { ToolUseInput } from './tools/types.js';
import { recordBedrockCallStart, recordBedrockCallSuccess, recordBedrockCallError, flushObservability } from './observability.js';

export type ConverseLoopResult = {
  fullText: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

function supportsThinking(modelId: string): boolean {
  const id = String(modelId || '').toLowerCase();
  return id.includes('anthropic.claude-sonnet-4-20250514')
    || id.includes('anthropic.claude-opus-4-20250514')
    || id.includes('anthropic.claude-3-7-sonnet-20250219');
}

// （未使用のリージョンスロットリング補助関数群を削除し、簡素化）

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
  const messages: Message[] = [{ role: 'user', content: [{ text: query }] }];
  // cacheUtils の固定式アンカー用: tools/system のブロック数を事前計算
  const counts = {
    systemBlocks: Array.isArray(system) ? system.length : 0,
    toolBlocks: (toolConfig as any)?.tools && Array.isArray((toolConfig as any).tools) ? (toolConfig as any).tools.length : 0,
  };

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
  console.log('\n========================================');
  console.log('[Region Router] リージョン設定');
  console.log('========================================');
  console.log(`総候補数: ${candidates.length}`);
  console.log(`ユニークリージョン数: ${regionOrder.length}`);
  console.log(`初期アクティブリージョン: ${regionOrder[activeRegionIndex]}`);
  console.log(`フェイルオーバー順序: ${regionOrder.join(' -> ')}`);
  console.log('各リージョンのモデル候補:');
  regionOrder.forEach((r, i) => {
    const models = regionToCandidates.get(r) || [];
    console.log(`  ${i + 1}. ${r}: ${models.map(m => m.modelId).join(', ')}`);
  });
  console.log('========================================\n');

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let fullText = '';
  let iterationCount = 0;
  const maxIterations = Number(process.env.AGENT_MAX_ITERATIONS) || 1000;

  while (true) {
    iterationCount += 1;
    console.log(`[ConversationLoop] イテレーション ${iterationCount}/${maxIterations}`);
    if (iterationCount > maxIterations) {
      console.log(`[Warning] 最大イテレーション数 ${maxIterations} に達しました。処理を終了します。`);
      fullText += `\n[注意] 最大イテレーション数に達したため、処理を終了しました。`;
      break;
    }
    const currentMessages = addCachePoints(messages, anyClaude, anyNova, counts as any);
    let response: ConverseResponse | undefined;
    let lastError: any;

    // 現在のアクティブリージョンから順に直列で試行し、成功リージョンを固定
    console.log(`[Region Router] 現在のアクティブリージョン: ${regionOrder[activeRegionIndex]} (index=${activeRegionIndex})`);
    for (let step = 0; step < regionOrder.length; step += 1) {
      const regionIndex = (activeRegionIndex + step) % regionOrder.length;
      const region = regionOrder[regionIndex]!;
      const regionCandidates = regionToCandidates.get(region) ?? [];
      if (!regionCandidates.length) continue;
      console.log(`[PerTurn Sequential] 試行リージョン ${step + 1}/${regionOrder.length}: region=${region} (index=${regionIndex})`);

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
        // ===== Thinking (Extended / Interleaved) 構成 =====
        const envThinkingEnabled = String(process.env.AGENT_THINKING_ENABLED ?? '').toLowerCase() === 'true';
        const envInterleaved = String(process.env.AGENT_THINKING_INTERLEAVED ?? '').toLowerCase() === 'true';
        const envBudgetRaw = Math.trunc(Number(process.env.AGENT_THINKING_BUDGET_TOKENS ?? 1024));
        const envMaxTokensRaw = Math.trunc(Number(process.env.AGENT_MAX_TOKENS ?? 4096));
        const maxTokens = Number.isFinite(envMaxTokensRaw) && envMaxTokensRaw > 0 ? envMaxTokensRaw : 4096;
        const thinkingBudgetBase = Number.isFinite(envBudgetRaw) && envBudgetRaw >= 1 ? envBudgetRaw : 1024;
        const useThinking = envThinkingEnabled && supportsThinking(modelId);

        // ツール設定はデフォルト（toolChoice 未指定）をそのまま使用
        const toolConfig = buildToolConfig();

        // Interleaved Thinking の beta ヘッダ（環境フラグ ON で常に付与を試行）
        const interleavedEnabled = useThinking && envInterleaved;
        if (interleavedEnabled) betaTags.push('interleaved-thinking-2025-05-14');
        if (betaTags.length) additionalModelRequestFields['anthropic_beta'] = betaTags;

        // thinking フィールド
        if (useThinking) {
          // 非 interleaved では budget_tokens < max_tokens を保証
          const budget = (!interleavedEnabled && thinkingBudgetBase >= maxTokens) ? Math.max(1, maxTokens - 1) : Math.max(1024, thinkingBudgetBase);
          additionalModelRequestFields['thinking'] = { type: 'enabled', budget_tokens: budget };
          try { console.log(`[Thinking] enabled model=${modelId} interleaved=${interleavedEnabled} budget_tokens=${budget} max_tokens=${maxTokens}`); } catch {}
        }

        const inferenceConfig: any = useThinking ? { maxTokens } : { maxTokens, temperature: 0 };

        try { console.log(`[Debug] toolChoice: ${JSON.stringify((toolConfig as any)?.toolChoice)}`); } catch {}

        const cmd = new ConverseCommand({
          modelId,
          system,
          toolConfig,
          messages: currentMessages as any,
          inferenceConfig,
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
            inferenceConfig,
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
            // Thinking ブロックのログ出力
            let thinkingJoined: string | undefined = undefined;
            try {
              const types: string[] = [];
              const thinkParts: string[] = [];
              for (const block of content) {
                try {
                  const hasReasoning = !!(block && (block as any).reasoningContent && (block as any).reasoningContent.reasoningText && (block as any).reasoningContent.reasoningText.text);
                  const t = typeof (block as any)?.type === 'string'
                    ? (block as any).type
                    : ((block as any)?.thinking || hasReasoning)
                      ? 'thinking'
                      : ((block as any)?.text
                        ? 'text'
                        : ((block as any)?.toolUse ? 'tool_use' : 'unknown'));
                  types.push(String(t));
                } catch {}
                if ((block as any)?.thinking) {
                  thinkParts.push(String((block as any).thinking));
                } else {
                  try {
                    const rt = (block as any)?.reasoningContent?.reasoningText?.text;
                    if (typeof rt === 'string' && rt.trim().length > 0) thinkParts.push(rt);
                  } catch {}
                }
              }
              try {
                console.log(`[Debug][content-types] ${JSON.stringify(types)}`);
                const dump = (obj: any) => {
                  try { const s = JSON.stringify(obj); return s.length > 1200 ? s.slice(0, 1200) + '…' : s; } catch { return String(obj); }
                };
                if (Array.isArray(content) && content.length) {
                  console.log(`[Debug][content[0]] ${dump(content[0])}`);
                  if (content.length > 1) console.log(`[Debug][content[1]] ${dump(content[1])}`);
                }
              } catch {}
              if (thinkParts.length) {
                thinkingJoined = thinkParts.join('\n');
                const preview = thinkingJoined.length > 1200 ? (thinkingJoined.slice(0, 1200) + '…') : thinkingJoined;
                console.log(`[Thinking][preview] ${preview}`);
              } else {
                console.log('[Thinking] thinking blocks were not present in the response content.');
              }
            } catch {}
            const payload: any = { usage, response: res };
            if (typeof textOut === 'string') payload.outputText = textOut;
            if (typeof thinkingJoined === 'string') (payload as any).thinking = thinkingJoined;
            recordBedrockCallSuccess(obsHandle, payload);
          } catch {}
          response = res;
          if (activeRegionIndex !== regionIndex) {
            console.log(`[Region Router] ✅ 成功！アクティブリージョンを更新: ${regionOrder[activeRegionIndex]} (index=${activeRegionIndex}) -> ${region} (index=${regionIndex})`);
            activeRegionIndex = regionIndex;
          } else {
            console.log(`[Region Router] ✅ 成功！現在のアクティブリージョン ${region} (index=${regionIndex}) を継続使用`);
          }
          break;
        } catch (e: any) {
          try { recordBedrockCallError(obsHandle, e, { modelId, region }); } catch {}
          lastError = e;
          const errorName = String(e?.name || 'UnknownError');
          const errorMsg = String(e?.message || e || '');
          const errorCode = String(e?.code || e?.$metadata?.httpStatusCode || '');
          console.log(`[Region Attempt] 失敗 model=${modelId} region=${region}`);
          console.log(`  - エラー名: ${errorName}`);
          console.log(`  - エラーコード: ${errorCode}`);
          console.log(`  - メッセージ: ${errorMsg.substring(0, 200)}${errorMsg.length > 200 ? '...' : ''}`);
          if (e?.$metadata) {
            console.log(`  - HTTPステータス: ${e.$metadata.httpStatusCode || 'N/A'}`);
            console.log(`  - リクエストID: ${e.$metadata.requestId || 'N/A'}`);
          }
          
          // ThrottlingException の場合は短い待機を挟む
          if (errorName === 'ThrottlingException' || errorMsg.toLowerCase().includes('throttl')) {
            const waitMs = 2000 + Math.random() * 3000; // 2-5秒のランダムな待機
            console.log(`  - ThrottlingException検出: ${Math.round(waitMs)}ms 待機してから次のリージョンを試行します`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
          continue;
        }
      }

      if (response) break; // このリージョンで成功
      console.log(`[PerTurn Sequential] リージョン失敗: ${region} → 次リージョンへフェイルオーバー`);
    }

    if (!response) {
      console.error('\n========================================');
      console.error('[FATAL] すべてのリージョン/モデルでBedrock APIの呼び出しに失敗しました');
      console.error('========================================');
      console.error(`試行したリージョン数: ${regionOrder.length}個`);
      console.error(`試行順序: ${regionOrder.map((r, i) => {
        const idx = (activeRegionIndex + i) % regionOrder.length;
        return `${i + 1}. ${regionOrder[idx]}`;
      }).join(' -> ')}`);
      console.error(`エラー名: ${lastError?.name || 'Unknown'}`);
      console.error(`エラーメッセージ: ${lastError?.message || lastError}`);
      console.error(`エラーコード: ${lastError?.code || 'N/A'}`);
      
      // よくあるエラーの診断情報
      const errorMsg = String(lastError?.message || '').toLowerCase();
      if (errorMsg.includes('timeout') || lastError?.name?.includes('Timeout')) {
        console.error('\n[診断] タイムアウトエラーが発生しています');
        console.error('  → ネットワーク接続を確認してください');
        console.error('  → タイムアウト設定を増やすには AGENT_TIMEOUT_MS 環境変数を設定してください');
      } else if (errorMsg.includes('credentials') || errorMsg.includes('unauthorized') || lastError?.name?.includes('Credentials')) {
        console.error('\n[診断] AWS認証エラーが発生しています');
        console.error('  → AWS_ACCESS_KEY_ID と AWS_SECRET_ACCESS_KEY が正しく設定されているか確認してください');
        console.error('  → または AWS_PROFILE が正しく設定されているか確認してください');
      } else if (errorMsg.includes('throttl') || errorMsg.includes('rate')) {
        console.error('\n[診断] レート制限エラーが発生しています');
        console.error('  → しばらく待ってから再試行してください');
      } else if (errorMsg.includes('model') || errorMsg.includes('not found')) {
        console.error('\n[診断] モデルIDまたはリージョンが正しくない可能性があります');
        console.error('  → AGENT_BEDROCK_MODEL_ID と AGENT_AWS_REGION を確認してください');
      }
      
      if (lastError?.stack) {
        console.error('\nスタックトレース:');
        console.error(lastError.stack);
      }
      console.error('========================================\n');
      throw lastError ?? new Error('No response from Bedrock');
    }

    const usage = response.usage ?? ({} as any);
    totalInput += usage.inputTokens ?? 0;
    totalOutput += usage.outputTokens ?? 0;
    totalCacheRead += usage.cacheReadInputTokens ?? 0;
    totalCacheWrite += usage.cacheWriteInputTokens ?? 0;

    const stopReason = response.stopReason as string | undefined;
    const out = response.output as any;
    console.log(`[ConversationLoop] stopReason: ${stopReason}`);
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
        if (name === 'todo') {
          const input = (toolUse as any).input ?? {};
          parallelTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: todo with input: ${JSON.stringify(input)}`);
            const result = await todoTool(input as any);
            console.log(`Tool result (todo): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_snapshot') {
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log('Calling tool: browser_snapshot {}');
            const result = await browserSnapshot();
            console.log(`Tool result (browser_snapshot): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'snapshot_search') {
          const inp = (toolUse as any).input ?? {};
          parallelTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: snapshot_search with input: ${JSON.stringify(inp).slice(0, 500)}${JSON.stringify(inp).length > 500 ? '...' : ''}`);
            const result = await snapshotSearch(inp);
            console.log(`Tool result (snapshot_search): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'snapshot_fetch') {
          const inp = (toolUse as any).input ?? {};
          parallelTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: snapshot_fetch with input: ${JSON.stringify(inp)}`);
            const result = await snapshotFetch(inp);
            console.log(`Tool result (snapshot_fetch): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_login') {
          const url = (toolUse as any).input?.url ?? '';
          const queryText = (toolUse as any).input?.query ?? '';
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_login ${JSON.stringify({ url, query: queryText })}`);
            const result = await browserLogin(String(url), String(queryText || ''));
            console.log(`Tool result (browser_login): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_goto') {
          const url = String((toolUse as any).input?.url ?? '');
          const id = String((toolUse as any).input?.id ?? '');
          const autoLogin = (toolUse as any).input?.autoLogin;
          const queryText = (toolUse as any).input?.query ?? '';
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_goto ${JSON.stringify({ url, id, autoLogin, query: queryText })}`);
            const opts: { autoLogin?: boolean; isId?: boolean; query?: string } = {};
            if (typeof autoLogin === 'boolean') opts.autoLogin = autoLogin;
            if (queryText) opts.query = String(queryText);
            let result: string;
            if (id && !url) {
              opts.isId = true;
              result = await browserGoto(String(id), opts);
            } else {
              result = await browserGoto(String(url), opts);
            }
            console.log(`Tool result (browser_goto): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_click') {
          const inp = (toolUse as any).input ?? {};
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_click ${JSON.stringify(inp)}`);
            const payload: any = { 
              ref: String(inp.ref ?? '').trim(), 
              query: String(inp.query ?? '') 
            };
            const result = await browserClick(payload);
            console.log(`Tool result (browser_click): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_input') {
          const inp = (toolUse as any).input ?? {};
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_input ${JSON.stringify(inp)}`);
            const payload: any = { 
              ref: String(inp.ref ?? '').trim(), 
              text: String(inp.text ?? ''), 
              query: String(inp.query ?? '') 
            };
            const result = await browserInput(payload);
            console.log(`Tool result (browser_input): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
            return result;
          }});
        } else if (name === 'browser_press') {
          const inp = (toolUse as any).input ?? {};
          browserTasks.push({ index: i, toolUseId, run: async () => {
            console.log(`Calling tool: browser_press ${JSON.stringify(inp)}`);
            const payload: any = { 
              ref: String(inp.ref ?? '').trim(), 
              key: String(inp.key ?? ''), 
              query: String(inp.query ?? '') 
            };
            const result = await browserPress(payload);
            console.log(`Tool result (browser_press): ${result.substring(0, 500)}${result.length > 500 ? '...' : ''}`);
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
        console.log(`[ToolExecution] Adding ${toolResults.length} tool result(s) to messages`);
        messages.push({ role: 'user', content: toolResults });
        // 以降の省略は addCachePoints 内で一元的に実施する（ここでは何もしない）
      } else {
        console.log('[Warning] ツール使用が要求されましたが、実行可能なツールが見つかりませんでした。空の結果を返します。');
        messages.push({ role: 'user', content: [{ text: 'ツールの実行に失敗しました。' }] });
      }
      continue;
    }
    if (stopReason === 'max_tokens') {
      fullText += '\n[注意] 最大トークン数に達しました。応答が途切れている可能性があります。';
      break;
    }
    // その他のstopReason（stop_sequence, content_filtered等）も正常終了として扱う
    console.log(`[Warning] 予期しないstopReasonでループを終了します: ${stopReason}`);
    const content = out?.message?.content ?? [];
    for (const block of content) if (block.text) fullText += block.text;
    if (stopReason === 'content_filtered') {
      fullText += '\n[注意] コンテンツフィルタリングにより応答が制限されました。';
    } else if (stopReason) {
      fullText += `\n[注意] 停止理由: ${stopReason}`;
    }
    break;
  }

  try { await flushObservability(); } catch {}
  return { fullText, usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite } };
}




