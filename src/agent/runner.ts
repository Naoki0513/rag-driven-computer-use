import { converseLoop } from './converse.js';
import { getDatabaseSchemaString } from './schema.js';
import { createSystemPromptWithSchema } from './prompt.js';
import { ensureSharedBrowserStarted, closeSharedBrowserWithDelay, finalizeWebArenaTrajectory, saveWebArenaTrajectory, initWebArenaTrajectory } from './tools/util.js';
import { startSessionTrace } from './observability.js';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

type ModelCandidate = { modelId: string; region: string };

function detectRegionFromModelId(modelId: string): string | null {
  const lower = String(modelId || '').toLowerCase();
  if (lower.startsWith('us.')) return 'us-west-2';
  if (lower.startsWith('eu.')) return 'eu-west-3';
  if (lower.startsWith('apac.')) return 'ap-northeast-1';
  return null;
}

function parseRegionsFromEnv(): string[] {
  const raw = String(process.env.AGENT_AWS_REGION ?? '').trim();
  if (!raw) return [];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // 重複排除（順序維持）
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of list) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

function regionsMatchingModelIdPrefix(modelId: string, regions: string[]): string[] {
  const lower = String(modelId || '').toLowerCase();
  if (!regions.length) return [];
  if (lower.startsWith('us.')) return regions.filter((r) => r.startsWith('us-'));
  if (lower.startsWith('eu.')) return regions.filter((r) => r.startsWith('eu-'));
  if (lower.startsWith('apac.')) return regions.filter((r) => r.startsWith('ap-'));
  return regions;
}

function buildModelCandidates(): ModelCandidate[] {
  const listEnv = String(process.env.AGENT_BEDROCK_MODEL_IDS ?? '').trim();
  const singleModel = String(process.env.AGENT_BEDROCK_MODEL_ID ?? '').trim();
  const regionList = parseRegionsFromEnv();
  const candidates: ModelCandidate[] = [];

  if (listEnv) {
    const ids = listEnv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const id of ids) {
      // AGENT_AWS_REGION に複数渡された場合は、その全リージョン（モデル接頭辞に合致するもの）で候補を生成
      const regionCandidates = regionsMatchingModelIdPrefix(id, regionList);
      if (regionCandidates.length > 0) {
        for (const r of regionCandidates) candidates.push({ modelId: id, region: r });
      } else {
        const fallback = detectRegionFromModelId(id) || regionList[0];
        if (!fallback) {
          throw new Error(`モデルIDからリージョンを特定できませんでした。modelId=${id} に対応するリージョンが不明です（us./eu./apac. 接頭辞、または AGENT_AWS_REGION を設定してください）`);
        }
        candidates.push({ modelId: id, region: fallback });
      }
    }
    return candidates;
  }

  if (singleModel) {
    // 単一変数にカンマ区切りで渡された場合もサポート
    const ids = singleModel.includes(',')
      ? singleModel.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [singleModel];
    const list: ModelCandidate[] = [];
    for (const id of ids) {
      const regionCandidates = regionsMatchingModelIdPrefix(id, regionList);
      if (regionCandidates.length > 0) {
        for (const r of regionCandidates) list.push({ modelId: id, region: r });
      } else {
        const fallback = detectRegionFromModelId(id) || regionList[0];
        if (!fallback) {
          throw new Error('AGENT_AWS_REGION が未設定です (.env を確認)');
        }
        list.push({ modelId: id, region: fallback });
      }
    }
    return list;
  }

  throw new Error('AGENT_BEDROCK_MODEL_IDS もしくは AGENT_BEDROCK_MODEL_ID が未設定です (.env を確認)');
}

export async function runSingleQuery(query: string): Promise<void> {
  console.log('WebGraph-Agent DuckDB/CSV AI エージェントを起動しています...');
  console.log('\n========================================');
  console.log('[環境変数] 詳細情報');
  console.log('========================================');
  
  // 環境変数の詳細出力
  const csvPath = String(process.env.AGENT_CSV_PATH || '').trim() || 'output/crawl.csv';
  console.log(`CSV Path: ${csvPath}`);
  
  const rawRegions = String(process.env.AGENT_AWS_REGION ?? '').trim();
  console.log(`AGENT_AWS_REGION (生): "${rawRegions}"`);
  const parsedRegions = parseRegionsFromEnv();
  console.log(`AGENT_AWS_REGION (解析後): [${parsedRegions.join(', ')}] (${parsedRegions.length}個)`);
  
  const modelIds = String(process.env.AGENT_BEDROCK_MODEL_IDS ?? process.env.AGENT_BEDROCK_MODEL_ID ?? '').trim();
  console.log(`AGENT_BEDROCK_MODEL_IDS: "${modelIds}"`);
  
  const headful = String(process.env.AGENT_HEADFUL ?? 'false').trim();
  const display = String(process.env.DISPLAY ?? '').trim();
  console.log(`AGENT_HEADFUL: ${headful}`);
  console.log(`DISPLAY: "${display}"`);
  
  const thinkingEnabled = String(process.env.AGENT_THINKING_ENABLED ?? 'false').trim();
  console.log(`AGENT_THINKING_ENABLED: ${thinkingEnabled}`);
  
  // AWS認証情報のチェック
  const hasAwsKey = !!process.env.AWS_ACCESS_KEY_ID;
  const hasAwsSecret = !!process.env.AWS_SECRET_ACCESS_KEY;
  const hasAwsProfile = !!process.env.AWS_PROFILE;
  console.log(`AWS認証: AccessKey=${hasAwsKey ? '✓' : '✗'} SecretKey=${hasAwsSecret ? '✓' : '✗'} Profile=${hasAwsProfile ? '✓' : '✗'}`);
  if (!hasAwsKey && !hasAwsSecret && !hasAwsProfile) {
    console.warn('[警告] AWS認証情報が設定されていない可能性があります');
  }
  console.log('========================================\n');
  
  const candidates = buildModelCandidates();
  console.log(`[OK] 実行環境チェックに成功しました。モデル候補数=${candidates.length}`);
  console.log(`[Env] モデル候補の詳細:`);
  candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.modelId} @ ${c.region}`);
  });

  // Langfuse セッション（1回の runSingleQuery を1セッションとして紐づけ）
  const sessionId = `agent-session-${Date.now()}`;
  startSessionTrace(sessionId, 'WebGraph Agent Session', { queryPreview: query.slice(0, 120) });

  // まず最初にブラウザを起動（以降の実行で共有・再利用）
  await ensureSharedBrowserStarted();
  
  // WebArena Trajectory初期化
  await initWebArenaTrajectory();
  
  try {
    console.log('CSVスキーマを取得中...');
    const schema = await getDatabaseSchemaString();
    console.log('[OK] CSVスキーマを取得しました');

    const systemPrompt = createSystemPromptWithSchema(schema);
    console.log(`\n実行中のクエリ: ${query}`);
    console.log('\nエージェント:');

    const { fullText, usage } = await converseLoop(query, systemPrompt, candidates);
    console.log(fullText);
    console.log('\nトークン使用情報:');
    console.log(`- 総入力トークン数: ${usage.input}`);
    console.log(`- 総出力トークン数: ${usage.output}`);
    console.log(`- 総キャッシュ読み取りトークン数: ${usage.cacheRead}`);
    console.log(`- 総キャッシュ書き込みトークン数: ${usage.cacheWrite}`);
    console.log(`- 総トークン数: ${usage.input + usage.output}`);

    // ToDo ファイルの内容を最後にログ出力（検証用）
    try {
      const todoPath = path.resolve(process.cwd(), 'todo.md');
      const content = (await fs.readFile(todoPath)).toString('utf-8');
      console.log('\n現在の ToDo (todo.md):');
      console.log('----------------------------------------');
      console.log(content.trim() || '(空)');
      console.log('----------------------------------------');
    } catch {
      console.log('\n現在の ToDo (todo.md): (ファイルなし)');
    }

    // WebArena評価の実行（オプション）
    const enableWebArenaEval = String(process.env.AGENT_WEBARENA_EVAL ?? 'false').toLowerCase() === 'true';
    if (enableWebArenaEval) {
      await runWebArenaEvaluation(query, fullText);
    }
  } catch (e: any) {
    console.error('\n========================================');
    console.error('[エラー] エージェント実行中にエラーが発生しました');
    console.error('========================================');
    console.error(`エラー種別: ${e?.name || 'Unknown'}`);
    console.error(`エラーメッセージ: ${e?.message || e}`);
    if (e?.stack) {
      console.error('\nスタックトレース:');
      console.error(e.stack);
    }
    if (e?.$metadata) {
      console.error('\nAWS メタデータ:', JSON.stringify(e.$metadata, null, 2));
    }
    console.error('========================================\n');
    throw e; // 上位のcli.tsで処理させるため再スロー
  } finally {
    // 完了時に5秒（または環境変数の指定 ms）待ってからクローズ
    await closeSharedBrowserWithDelay();
  }
}

async function runWebArenaEvaluation(query: string, answer: string): Promise<void> {
  try {
    console.log('\n[WebArena] 評価を開始します...');
    
    // Trajectory確定
    await finalizeWebArenaTrajectory(answer);
    
    // CDP Endpoint取得（DevToolsポートから生成）
    const { browser, context } = await ensureSharedBrowserStarted();
    const cdpPortEnv = String(process.env.AGENT_CDP_PORT || '').trim();
    const cdpPort = Number.isFinite(Number(cdpPortEnv)) && Math.trunc(Number(cdpPortEnv)) > 0 ? Math.trunc(Number(cdpPortEnv)) : 9222;
    const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
    
    // Trajectory保存（タスクID付きで構造化）
    const configFilePath = String(process.env.AGENT_WEBARENA_CONFIG_FILE || '').trim();
    const taskId = configFilePath ? path.basename(configFilePath, '.json') : 'unknown';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    
    const explicitTraj = String(process.env.AGENT_WEBARENA_TRAJECTORY_FILE || '').trim();
    const trajPath = explicitTraj
      ? path.resolve(process.cwd(), 'output', 'webarena', 'trajectories', `task_${taskId}_${timestamp}.json`)
      : path.resolve(process.cwd(), 'output', 'webarena', 'trajectories', `task_${taskId}_${timestamp}.json`);
    const evaluatedAt = new Date().toISOString();
    await saveWebArenaTrajectory(trajPath, cdpEndpoint, evaluatedAt);
    console.log(`[WebArena] Trajectory保存: ${trajPath}`);
    
    // Python評価スクリプト実行
    if (!configFilePath) {
      console.log('[WebArena] AGENT_WEBARENA_CONFIG_FILE が未設定のため評価をスキップします');
      return;
    }
    
    const evalScript = path.resolve(process.cwd(), 'scripts', 'evaluate_webarena.py');
    const pyBin = String(process.env.AGENT_PYTHON_BIN || '').trim() || 'python3';
    console.log(`[WebArena] 評価実行: ${evalScript}`);
    
    const resultPath = path.resolve(process.cwd(), 'output', 'webarena', 'results', `task_${taskId}_${timestamp}.json`);
    
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(pyBin, [evalScript, trajPath, configFilePath, cdpEndpoint, resultPath], {
        stdio: 'inherit',
        cwd: process.cwd()
      });
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('[WebArena] 評価完了');
          resolve();
        } else {
          console.log(`[WebArena] 評価失敗（終了コード: ${code}）`);
          reject(new Error(`評価スクリプトが失敗しました: ${code}`));
        }
      });
      proc.on('error', (err) => {
        console.error('[WebArena] 評価エラー:', err);
        reject(err);
      });
    });
  } catch (e: any) {
    console.error('[WebArena] 評価中にエラーが発生しました:', e?.message ?? e);
  }
}

