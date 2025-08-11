import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WebCrawler } from './crawler.js';

async function main() {
  const cli = yargs(hideBin(process.argv))
    .options({
      url: { type: 'string', describe: 'Target URL to crawl' },
      user: { type: 'string', describe: 'Login username' },
      password: { type: 'string', describe: 'Login password' },
      depth: { type: 'number', describe: 'Max exploration depth' },
      limit: { type: 'number', describe: 'Max states' },
      headful: { type: 'boolean', describe: 'Show browser' },
      parallel: { type: 'number', describe: 'Parallel tasks' },
      'no-clear': { type: 'boolean', describe: 'Do not clear database' },
      exhaustive: { type: 'boolean', describe: 'Exhaustive crawl ignoring limits' },
    })
    .help(false)
    .parseSync();

  const env = process.env;
  const toBool = (v: any, def: boolean) => (v === undefined ? def : String(v).toLowerCase() === 'true');
  const toInt = (v: any, def: number) => {
    const n = v === undefined ? def : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
  };

  const config = {
    neo4jUri: env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4jUser: env.NEO4J_USER ?? 'neo4j',
    neo4jPassword: env.NEO4J_PASSWORD ?? 'testpassword',

    targetUrl: (cli.url as string) ?? env.TARGET_URL ?? 'http://the-agent-company.com:3000/',
    loginUser: (cli.user as string) ?? env.LOGIN_USER ?? 'theagentcompany',
    loginPass: (cli.password as string) ?? env.LOGIN_PASS ?? 'theagentcompany',

    maxStates: toInt(cli.limit ?? env.MAX_STATES, 10000),
    maxDepth: toInt(cli.depth ?? env.MAX_DEPTH, 20),
    parallelTasks: toInt(cli.parallel ?? env.PARALLEL_TASKS, 8),

    headful: toBool(cli.headful ?? env.HEADFUL, false),
    clearDb: cli['no-clear'] ? false : toBool(env.CLEAR_DB, true),
    exhaustive: toBool(cli.exhaustive ?? env.EXHAUSTIVE, false),
  } as any;

  for (const key of ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD']) {
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


