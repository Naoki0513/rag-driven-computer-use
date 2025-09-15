import 'dotenv/config';
import { collectAllInternalUrls } from './url-collector.js';
import { CsvWriter } from './csv.js';
import { captureNode } from '../utilities/snapshots.js';
import { normalizeUrl } from '../utilities/url.js';

async function main() {
  try { (process.stdout as any).on?.('error', () => {}); } catch {}
  try { (process.stderr as any).on?.('error', () => {}); } catch {}

  const env = process.env;
  const toBool = (v: any, def: boolean) => (v === undefined ? def : String(v).toLowerCase() === 'true');
  const outputFileEnv = (env.CRAWLER_OUTPUT_FILE ?? env.CRAWLER_CSV_PATH ?? '').toString().trim();

  const config = {
    loginUser: env.CRAWLER_LOGIN_USER ?? 'theagentcompany',
    loginPass: env.CRAWLER_LOGIN_PASS ?? 'theagentcompany',
    headful: toBool(env.CRAWLER_HEADFUL, false),
    csvPath: outputFileEnv || 'output/crawl.csv',
    clearCsv: toBool(env.CRAWLER_CLEAR_CSV, false),
    dedupeElementsPerBase: toBool(env.CRAWLER_DEDUPE_ELEMENTS_PER_BASE, false),
  } as const;

  const targetsEnv = (env.CRAWLER_TARGET_URLS || '').trim();
  const maxUrlsEnv = Number(env.CRAWLER_MAX_URLS ?? '');
  const maxUrls = Number.isFinite(maxUrlsEnv) && maxUrlsEnv > 0 ? Math.trunc(maxUrlsEnv) : undefined;
  const targetUrls: string[] = targetsEnv
    ? targetsEnv.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    : ['http://the-agent-company.com:3000/'];

  // CSV: 常に出力（URLのみモードは廃止）
  const csv = new CsvWriter(config.csvPath || 'output/crawl.csv', [
    'URL',
    'id',
    'site',
    'snapshotfor AI',
    'snapshotin MD',
    'timestamp',
  ], { clear: !!config.clearCsv });
  await csv.initialize();

  // URL発見時・ベースURL訪問時のCSV出力を callbacks で実現
  const fullWritten = new Set<string>();

  const onDiscovered = async (_url: string) => {
    // プレースホルダー書き込みは廃止（フル行のみ書き込み）
  };

  const onBaseCapture = async (node: Awaited<ReturnType<typeof captureNode>>) => {
    const u = normalizeUrl(node.url);
    if (fullWritten.has(u)) return;
    // CRAWLER_MAX_URLS を CSV フル行の件数上限として適用
    if (typeof maxUrls === 'number' && fullWritten.size >= maxUrls) {
      try { console.info(`[CSV] skip (reached maxUrls=${maxUrls}) -> ${u}`); } catch {}
      return;
    }
    await csv.appendNode(node);
    fullWritten.add(u);
    try { console.info(`[CSV] base captured -> ${u}`); } catch {}
  };

  // 各ベースURLで BFS し、callbacks 内で逐次 CSV を執筆
  const unionAll = new Set<string>();
  for (const base of targetUrls) {
    const cfg: any = {
      targetUrl: base,
      loginUser: config.loginUser,
      loginPass: config.loginPass,
      headful: !!config.headful,
      dedupeElementsPerBase: !!config.dedupeElementsPerBase,
      onDiscovered,
      onBaseCapture,
      shouldStop: () => (typeof maxUrls === 'number' ? fullWritten.size >= maxUrls : false),
    };
    // url-collector 側へ maxUrls は渡さない（収集は継続し、CSV 書込みのみ本ファイルで制御）
    const collected = await collectAllInternalUrls(cfg).catch((e) => {
      try { console.warn(`[crawler] collect error for base=${base}: ${String((e as any)?.message ?? e)}`); } catch {}
      return [] as string[];
    });
    for (const u of collected) unionAll.add(u);
    // 進捗ログ: 現時点の unionAll をすべて表示
    try {
      console.info(`[discovered(total) progress] total=${unionAll.size}`);
      for (const u of Array.from(unionAll).sort()) console.info(`DISCOVERED: ${u}`);
    } catch {}
    // 収集は継続。CSV の新規書込みは onBaseCapture で制御
    if (typeof maxUrls === 'number' && fullWritten.size >= maxUrls) break;
  }

  try {
    console.info(`[CSV] completed. rows(full)=${fullWritten.size} discovered(total)=${unionAll.size}`);
    // 完了ログ: 最終的な unionAll をすべて表示
    console.info(`[discovered(total) final] total=${unionAll.size}`);
    for (const u of Array.from(unionAll).sort()) console.info(`DISCOVERED: ${u}`);
  } catch {}
  await csv.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


