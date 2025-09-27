import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function getNpmCmd(): string { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

async function pathExists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }

function getCsvPath(): string {
  const p = String(process.env.AGENT_CSV_PATH || '').trim();
  return p || path.resolve(process.cwd(), 'output', 'crawl.csv');
}

function requireEnv(name: string): void {
  const v = String((process.env as any)[name] || '').trim();
  if (!v) throw new Error(`環境変数 ${name} が未設定です。CI/act のジョブ環境または .env で設定してください。`);
}

async function runAgentAndCapture(prompt: string): Promise<{ code: number; stdout: string; stderr: string }>{
  return await new Promise((resolve) => {
    const args = ['run', 'start:agent', '--', '--prompt', prompt];
    const child = spawn(getNpmCmd(), args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { const s = d.toString('utf-8'); out += s; process.stdout.write(s); });
    child.stderr?.on('data', (d: Buffer) => { const s = d.toString('utf-8'); err += s; process.stderr.write(s); });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

type PromptSpec = { name: string; text: string; expectTools: string[]; softExpect?: string[] };

function checkTools(output: string, tools: string[]): { missing: string[]; present: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const t of tools) {
    const re1 = new RegExp(`Calling tool:\\s*${t}\\b`);
    const re2 = new RegExp(`Tool result \\(${t}\\)\\b`);
    if (re1.test(output) || re2.test(output)) present.push(t); else missing.push(t);
  }
  return { missing, present };
}

async function main() {
  // 実行前チェック
  const csvPath = getCsvPath();
  if (!(await pathExists(csvPath))) {
    throw new Error(`AGENT_CSV_PATH が指す CSV が存在しません: ${csvPath}\n先にクローラE2Eを成功させてCSVを生成してください。`);
  }

  // モデル/リージョンは必須（LLM推論に必要）
  requireEnv('AGENT_AWS_REGION');
  const hasList = String(process.env.AGENT_BEDROCK_MODEL_IDS || '').trim().length > 0;
  const hasSingle = String(process.env.AGENT_BEDROCK_MODEL_ID || '').trim().length > 0;
  if (!hasList && !hasSingle) {
    throw new Error('AGENT_BEDROCK_MODEL_IDS または AGENT_BEDROCK_MODEL_ID を設定してください。');
  }

  // 単一のプロンプトで全ツール（browser_login除外）を網羅
  const prompts: PromptSpec[] = [
    {
      name: 'P: 単一・簡潔プロンプトで全ツール網羅（browser_login不要）',
      text: [
        'E2Eテストのため、利用可能なすべてのツールを1回以上確実に呼び出して実行してください。',
        '対象は books.toscrape.com の pages ビュー内のみ。必要に応じて DB(run_query) やページのスナップショット(browser_snapshot)で事前確認を行い、安全に操作できる URL/ID を選んでください。',
        'browser_login は呼び出さないでください。',
        '期待するツール: run_query, snapshot_search, browser_goto, browser_snapshot, browser_flow, browser_input, browser_press, browser_click, todo。',
        'ヒント: COUNT を使う場合は CAST(COUNT(*) AS VARCHAR) でエラー回避可。browser_goto は autoLogin:false を指定し、id 指定時は isId:true を使っても良い。',
        'browser_flow では Travel をクリック→Home へ戻る等の簡単な流れを含め、最後に browser_snapshot の本文を1回取得して1-2行でまとめてください。',
        '出力は日本語で簡潔に。'
      ].join(' | '),
      expectTools: ['run_query','snapshot_search','browser_goto','browser_snapshot','browser_flow','browser_input','browser_press','browser_click','todo']
    }
  ];

  const usedTools = new Set<string>();
  for (const p of prompts) {
    console.log(`\n[E2E][agent] ==== ${p.name} ====\n`);
    const { code, stdout, stderr } = await runAgentAndCapture(p.text);
    if (code !== 0) throw new Error(`[E2E][agent] 失敗 (${p.name}): exitCode=${code}\nSTDERR:\n${stderr}`);
    const { missing, present } = checkTools(stdout, p.expectTools);
    present.forEach((t) => usedTools.add(t));
    if (p.softExpect && p.softExpect.length) {
      const soft = checkTools(stdout, p.softExpect);
      soft.present.forEach((t) => usedTools.add(t));
      if (soft.missing.length) {
        console.log(`[E2E][agent] 注意 (${p.name}): 任意ツール未検出: ${soft.missing.join(', ')}`);
      }
    }
    if (missing.length) {
      throw new Error(`[E2E][agent] 失敗 (${p.name}): 期待ツール未検出: ${missing.join(', ')}`);
    }
    console.log(`[E2E][agent] OK (${p.name}): ツール検出: ${present.join(', ')}`);
  }

  // 全体で必要なツール網羅をチェック
  const requiredAll = ['run_query','snapshot_search','browser_goto','browser_snapshot','browser_flow','browser_input','browser_press','browser_click','todo'];
  const missingOverall = requiredAll.filter((t) => !usedTools.has(t));
  if (missingOverall.length) {
    throw new Error(`[E2E][agent] 失敗: 全体で未網羅のツール: ${missingOverall.join(', ')}`);
  }

  console.log('[E2E][agent] OK: 単一プロンプトで必要なツール呼び出しを網羅しました');
}

main().catch((e) => {
  console.error('[E2E][agent] 失敗:', e?.message ?? e);
  process.exitCode = 1;
});


