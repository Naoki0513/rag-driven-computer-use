import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';

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

const schema = z.object({
  neo4jUri: z.string().default(env.NEO4J_URI ?? 'bolt://localhost:7687'),
  neo4jUser: z.string().default(env.NEO4J_USER ?? 'neo4j'),
  neo4jPassword: z.string().default(env.NEO4J_PASSWORD ?? 'testpassword'),

  targetUrl: z.string().url().default(env.TARGET_URL ?? 'http://the-agent-company.com:3000/'),
  loginUser: z.string().default(env.LOGIN_USER ?? 'theagentcompany'),
  loginPass: z.string().default(env.LOGIN_PASS ?? 'theagentcompany'),

  maxStates: z.coerce.number().int().positive().default(Number(env.MAX_STATES ?? 10000)),
  maxDepth: z.coerce.number().int().positive().default(Number(env.MAX_DEPTH ?? 20)),
  parallelTasks: z.coerce.number().int().positive().default(Number(env.PARALLEL_TASKS ?? 8)),

  maxHtmlSize: z.coerce.number().int().positive().default(Number(env.MAX_HTML_SIZE ?? 100 * 1024)),
  maxAriaContextSize: z.coerce.number().int().positive().default(Number(env.MAX_ARIA_CONTEXT_SIZE ?? 2 * 1024)),

  headful: z.coerce.boolean().default(env.HEADFUL !== undefined ? env.HEADFUL === 'true' : false),
  clearDb: z.coerce.boolean().default(env.CLEAR_DB !== undefined ? env.CLEAR_DB === 'true' : true),
  exhaustive: z.coerce.boolean().default(env.EXHAUSTIVE !== undefined ? env.EXHAUSTIVE === 'true' : false),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  const config = schema.parse({
    neo4jUri: env.NEO4J_URI,
    neo4jUser: env.NEO4J_USER,
    neo4jPassword: env.NEO4J_PASSWORD,
    targetUrl: cli.url ?? env.TARGET_URL,
    loginUser: cli.user ?? env.LOGIN_USER,
    loginPass: cli.password ?? env.LOGIN_PASS,
    maxStates: cli.limit ?? env.MAX_STATES,
    maxDepth: cli.depth ?? env.MAX_DEPTH,
    parallelTasks: cli.parallel ?? env.PARALLEL_TASKS,
    maxHtmlSize: env.MAX_HTML_SIZE,
    maxAriaContextSize: env.MAX_ARIA_CONTEXT_SIZE,
    headful: cli.headful ?? env.HEADFUL,
    clearDb: cli['no-clear'] ? false : env.CLEAR_DB,
    exhaustive: cli.exhaustive ?? env.EXHAUSTIVE,
  });
  return config;
}

