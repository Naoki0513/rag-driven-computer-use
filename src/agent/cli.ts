import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSingleQuery } from './runner.js';
import { closeSharedBrowserWithDelay } from './tools/util.js';
import fs from 'fs';
import path from 'path';

// 強制終了/例外時のクリーンアップ（ブラウザ終了と todo.md 削除）
let _exiting = false;
async function gracefulCleanupAndExit(code: number): Promise<never> {
  if (_exiting) {
    // 既に終了処理中。待機せず即終了
    process.exit(code);
  }
  _exiting = true;
  try {
    // 即時クローズ（遅延 0ms）
    await closeSharedBrowserWithDelay(0);
  } catch {}
  try {
    const todoPath = path.resolve(process.cwd(), 'todo.md');
    if (fs.existsSync(todoPath)) {
      try { fs.unlinkSync(todoPath); } catch {}
    }
  } catch {}
  process.exit(code);
}

function installGlobalCleanupHandlers(): void {
  const onSignal = (sig: NodeJS.Signals) => {
    const code = sig === 'SIGINT' ? 130 : (sig === 'SIGTERM' ? 143 : 0);
    try { console.log(`[Signal] ${sig} を受信。クリーンアップして終了します...`); } catch {}
    // 非同期クリーンアップを待ってから終了
    void gracefulCleanupAndExit(code);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // Windows の Ctrl+Break 対応
  try { process.on('SIGBREAK', onSignal as any); } catch {}
  // 端末切断など
  try { process.on('SIGHUP', onSignal); } catch {}

  process.on('uncaughtException', (err) => {
    try { console.error('uncaughtException:', err?.message ?? err); } catch {}
    void gracefulCleanupAndExit(1);
  });
  process.on('unhandledRejection', (reason: any) => {
    try { console.error('unhandledRejection:', reason?.message ?? reason); } catch {}
    void gracefulCleanupAndExit(1);
  });

  // 最終フォールバック（同期削除のみ可能）
  process.on('exit', () => {
    try {
      const todoPath = path.resolve(process.cwd(), 'todo.md');
      if (fs.existsSync(todoPath)) {
        try { fs.unlinkSync(todoPath); } catch {}
      }
    } catch {}
  });
}

async function main() {
  installGlobalCleanupHandlers();
  const argv = yargs(hideBin(process.argv))
    .usage('$0 [query]')
    .option('prompt', {
      alias: 'p',
      type: 'string',
      describe: 'エージェントへのプロンプト（環境変数 AGENT_QUERY を上書き）',
    })
    .positional('query', { type: 'string', describe: '自然言語の質問/命令' })
    .help(false)
    .parseSync() as any;

  const envQuery = String(process.env.AGENT_QUERY ?? '').trim();
  const cliPromptOption = String(argv.prompt ?? '').trim();
  const positionalQuery = String(argv._[0] ?? argv.query ?? '').trim();
  // 優先度: --prompt/-p > 位置引数 > 環境変数
  const query = cliPromptOption || positionalQuery || envQuery;
  
  // WebArena評価モードの場合は、クエリが空でもOK（runner.tsでconfigから読み込む）
  const isWebArenaEval = String(process.env.AGENT_WEBARENA_EVAL ?? 'false').toLowerCase() === 'true';
  
  // 受理したクエリのソースと内容を先に表示して、引数伝播の検証を容易にする
  try {
    const source = cliPromptOption ? '--prompt' : (positionalQuery ? 'positional' : (envQuery ? 'env' : 'none'));
    if (source !== 'none') {
      console.log(`[CLI] query source=${source} value="${query}"`);
    } else if (isWebArenaEval) {
      console.log('[CLI] WebArena評価モード: configファイルからintentを読み込みます');
    }
  } catch {}
  
  if (!query && !isWebArenaEval) {
    console.error('クエリが指定されていません（--prompt/-p または 位置引数、もしくは AGENT_QUERY 環境変数で指定してください）');
    process.exit(1);
    return;
  }
  try {
    await runSingleQuery(query);
  } catch (e: any) {
    console.error('実行エラー:', e?.message ?? e);
    process.exit(1);
  }
}

main();


