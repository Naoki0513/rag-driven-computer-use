import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSingleQuery } from './runner.js';

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('$0 <query>')
    .positional('query', { type: 'string', describe: '自然言語の質問/命令', demandOption: true })
    .help(false)
    .parseSync() as any;

  const envQuery = String(process.env.AGENT_QUERY ?? '').trim();
  const query = envQuery || String(argv._[0] ?? argv.query ?? '').trim();
  if (!query) {
    console.error('クエリが指定されていません（AGENT_QUERY 環境変数 または 位置引数で指定してください）');
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


