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

  // 3つのプロンプトを順次実行して、全ツールの動作を検証
  const prompts: PromptSpec[] = [
    {
      name: 'P1: 集計 + 検索 + 遷移 + スナップショット + TODO + ログイン試行',
      text: [
        'books.toscrape.com のCSV(pages)を前提に、次を厳密に実行:',
        'PLAN/ToDo を作りながら進め、完了ごとに todo で setDone してください。',
        '1) run_query: SELECT COUNT(*) AS c FROM pages を実行して総件数を短く報告。',
        '2) run_query: SELECT URL FROM pages ORDER BY URL LIMIT 5 を実行して最初の5件を報告。',
        '3) snapshot_search: keywordQuery="books, category, travel, poetry" rerankQuery="Travel category top page" topK=3 を実行し、上位の {id,url} を示す。',
        '4) todo: 「Travelカテゴリへ遷移してスナップショット取得」「観察メモを残す」の2件を追加。',
        '5) browser_goto: (3)の最上位 id に autoLogin:true で遷移し、query="カテゴリ見出し/パンくず/件数/代表商品" で実行。',
        '6) browser_login: 現在ページに対して確認のため url="" で呼び出し、query="ログイン状態確認" を指定（存在しない場合はエラーでもよい）。',
        '7) browser_snapshot: スナップショット本文を取得。',
        '8) todo: 進捗を完了に更新。',
        '注意: 応答の最後に、最新以外のツールリザルトでは snapshots.text が省略される旨を一言添えてください。',
        '出力は日本語で簡潔に。'
      ].join('\n'),
      expectTools: ['run_query','snapshot_search','browser_goto','browser_snapshot','todo'],
      softExpect: ['browser_login']
    },
    {
      name: 'P2: browser_flow でカテゴリ遷移: クリック→（任意で）キー送信',
      text: [
        'books.toscrape.com のトップに対して browser_flow だけで以下を一括実行:',
        '1) steps: {action:"click", role:"link", name:"Travel"}',
        '2) steps: {action:"press", key:"End"}（任意）',
        '3) steps: {action:"click", role:"link", name:"Home"}',
        'flow 実行後の query は "Travel カテゴリの見出し/件数/パンくず/代表商品" を指定。',
        '最後に browser_snapshot を1回呼び、スナップショット本文を取得して1-2行で要約。',
        '結果を短く日本語で。'
      ].join('\n'),
      expectTools: ['browser_flow','browser_snapshot']
    },
    {
      name: 'P3: 個別操作(browser_input/press/click)での遷移',
      text: [
        'books.toscrape.com のホームで、browser_flow は使わず次を個別ツールで実行:',
        '1) browser_input: role:"textbox" に text:"Poetry" を入力（適切な入力欄が無い場合も試行）。query:"結果リスト/先頭リンク"。',
        '2) browser_press: role:"textbox" に key:"Enter" を送信（適切な入力欄が無い場合も試行）。query:"結果の件数/見出し"。',
        '3) browser_click: role:"link", name:"Home" をクリック。query:"ページの見出し/タイトル"。',
        '出力は日本語で簡潔に。'
      ].join('\n'),
      expectTools: ['browser_input','browser_press','browser_click']
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

  console.log('[E2E][agent] OK: 3プロンプトすべて成功し、必要なツール呼び出しを網羅しました');
}

main().catch((e) => {
  console.error('[E2E][agent] 失敗:', e?.message ?? e);
  process.exitCode = 1;
});


