import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WebCrawler } from './crawler.js';

async function main() {
  // CLIオプションは廃止。ヘルプや引数は読み取らず、.env からのみ設定を取得
  yargs(hideBin(process.argv)).help(false).parseSync();

  const env = process.env;
  const toBool = (v: any, def: boolean) => (v === undefined ? def : String(v).toLowerCase() === 'true');
  const toInt = (v: any, def: number) => {
    const n = v === undefined ? def : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
  };

  const config = {
    neo4jUri: env.CRAWLER_NEO4J_URI ?? 'bolt://localhost:7687',
    neo4jUser: env.CRAWLER_NEO4J_USER ?? 'neo4j',
    neo4jPassword: env.CRAWLER_NEO4J_PASSWORD ?? 'testpassword',

    targetUrl: env.CRAWLER_TARGET_URL ?? 'http://the-agent-company.com:3000/',
    loginUser: env.CRAWLER_LOGIN_USER ?? 'theagentcompany',
    loginPass: env.CRAWLER_LOGIN_PASS ?? 'theagentcompany',

    maxStates: toInt(env.CRAWLER_MAX_STATES, 10000),
    maxDepth: toInt(env.CRAWLER_MAX_DEPTH, 20),
    parallelTasks: toInt(env.CRAWLER_PARALLEL_TASKS, 8),

    headful: toBool(env.CRAWLER_HEADFUL, false),
    clearDb: toBool(env.CRAWLER_CLEAR_DB, true),
    exhaustive: toBool(env.CRAWLER_EXHAUSTIVE, false),
  } as any;

  for (const key of ['CRAWLER_NEO4J_URI', 'CRAWLER_NEO4J_USER', 'CRAWLER_NEO4J_PASSWORD']) {
    if (!env[key]) console.warn(`[警告] ${key} が未設定です。デフォルト値を使用します`);
  }

  const crawler = new WebCrawler(config);
  await crawler.initialize();
  try {
    await crawler.run();
  } finally {
    await crawler.cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


