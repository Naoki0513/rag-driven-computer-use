import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSingleQuery } from './runner.js';

async function main() {
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
  if (!query) {
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


