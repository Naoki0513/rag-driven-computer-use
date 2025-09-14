import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { chromium } from 'playwright';
import { collectAllInternalUrls, login } from './url-collector.js';
import { CsvWriter } from '../utilities/csv.js';
import { getTimeoutMs } from '../utilities/timeout.js';
import { captureNode } from '../utilities/snapshots.js';

async function main() {
  try { (process.stdout as any).on?.('error', () => {}); } catch {}
  try { (process.stderr as any).on?.('error', () => {}); } catch {}
  // CLIオプションは廃止。ヘルプや引数は読み取らず、.env からのみ設定を取得
  yargs(hideBin(process.argv)).help(false).parseSync();

  const env = process.env;
  const toBool = (v: any, def: boolean) => (v === undefined ? def : String(v).toLowerCase() === 'true');
  const toInt = (v: any, def: number) => {
    const n = v === undefined ? def : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
  };

  const config = {
    targetUrl: env.CRAWLER_TARGET_URL ?? 'http://the-agent-company.com:3000/',
    loginUrl: env.CRAWLER_LOGIN_URL ?? undefined,
    loginUser: env.CRAWLER_LOGIN_USER ?? 'theagentcompany',
    loginPass: env.CRAWLER_LOGIN_PASS ?? 'theagentcompany',

    maxStates: toInt(env.CRAWLER_MAX_STATES, 10000),
    maxDepth: toInt(env.CRAWLER_MAX_DEPTH, 20),
    parallelTasks: toInt(env.CRAWLER_PARALLEL_TASKS, 8),

    headful: toBool(env.CRAWLER_HEADFUL, false),
    exhaustive: toBool(env.CRAWLER_EXHAUSTIVE, false),

    csvPath: env.CRAWLER_CSV_PATH || 'output/crawl.csv',
    clearCsv: toBool(env.CRAWLER_CLEAR_CSV, false),

    // 新フロー: 環境変数で URL 収集のみを選択可能
    collectUrlsOnly: toBool(env.CRAWLER_URLS_ONLY, false),
    urlsOutJsonPath: env.CRAWLER_URLS_OUT_JSON || 'output/urls.json',
    urlsOutTxtPath: env.CRAWLER_URLS_OUT_TXT || 'output/urls.txt',
  } as any;

  const targetsEnv = (env.CRAWLER_TARGET_URLS || '').trim();
  const maxUrlsEnv = Number(env.CRAWLER_MAX_URLS ?? '');
  const maxUrls = Number.isFinite(maxUrlsEnv) && maxUrlsEnv > 0 ? Math.trunc(maxUrlsEnv) : undefined;
  const targetUrls: string[] = targetsEnv
    ? targetsEnv.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    : [config.targetUrl];

  // 1) 指定された各ベースURLごとにBFS収集し、逐次 urls.json/txt へ反映
  const unionAll = new Set<string>();
  for (const base of targetUrls) {
    const cfg: any = {
      targetUrl: base,
      loginUrl: config.loginUrl,
      loginUser: config.loginUser,
      loginPass: config.loginPass,
      headful: !!config.headful,
      urlsOutJsonPath: config.urlsOutJsonPath,
      urlsOutTxtPath: config.urlsOutTxtPath,
    };
    if (typeof maxUrls === 'number') cfg.maxUrls = maxUrls;
    const collected = await collectAllInternalUrls(cfg).catch(() => [] as string[]);
    for (const u of collected) unionAll.add(u);
    if (maxUrls && unionAll.size >= maxUrls) break;
  }

  // 2) URLのみ収集モードの場合はここで終了
  if (config.collectUrlsOnly) {
    try { console.info(`[URLs-ONLY] collected=${unionAll.size}`); } catch {}
    return;
  }

  // 3) 収集済みすべてのURLを対象にスナップショットを取得してCSVへ逐次出力
  const csv = new CsvWriter(config.csvPath || 'output/crawl.csv', [
    'URL',
    'id',
    'site',
    'snapshotfor AI',
    'snapshotin MD',
    'timestamp',
  ], { clear: !!config.clearCsv });
  await csv.initialize();

  const browser = await chromium.launch({ headless: !config.headful });
  const context = await browser.newContext();
  const page = await context.newPage();
  try { page.setDefaultTimeout(getTimeoutMs('crawler')); } catch {}
  try { page.setDefaultNavigationTimeout(getTimeoutMs('crawler')); } catch {}

  // 一度ログイン（セッション共有）
  await page.goto(config.loginUrl || config.targetUrl, { waitUntil: 'domcontentloaded', timeout: getTimeoutMs('crawler') }).catch(() => {});
  await login(page, config).catch(() => {});

  let successCount = 0;
  for (const url of Array.from(unionAll.values())) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: getTimeoutMs('crawler') });
      const node = await captureNode(page, { depth: 0 });
      await csv.appendNode(node);
      successCount += 1;
      try { console.info(`[CSV] appended -> ${url}`); } catch {}
    } catch (e) {
      try { console.warn(`[CSV] failed to capture ${url}: ${String((e as any)?.message ?? e)}`); } catch {}
    }
  }
  try { console.info(`[CSV] completed. rows=${successCount}`); } catch {}

  try { await page.close(); } catch {}
  try { await context.close(); } catch {}
  try { await browser.close(); } catch {}
  await csv.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


