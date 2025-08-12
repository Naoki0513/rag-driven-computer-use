import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSingleQuery } from './runner.js';

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('$0 [options] <query>')
    .option('headful', {
      type: 'boolean',
      describe: 'ヘッドフルモードでブラウザを起動（Playwright）',
    })
    .positional('query', { type: 'string', describe: '自然言語の質問/命令', demandOption: true })
    .help(false)
    .parseSync() as any;

  // CLIフラグを環境変数に反映（.envよりCLIを優先）
  if (typeof argv.headful === 'boolean') {
    process.env.HEADFUL = argv.headful ? 'true' : 'false';
  }

  const query = String(argv._[0] ?? argv.query ?? '').trim();
  if (!query) {
    console.error('クエリが指定されていません');
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


