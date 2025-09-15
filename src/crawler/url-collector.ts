import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { getTimeoutMs } from '../utilities/timeout.js';
import { normalizeUrl, canonicalUrlKey } from '../utilities/url.js';
import { capture } from './capture.js';
import { extractInternalUrlsFromSnapshot } from './url-extraction.js';
import { login } from './session.js';
import { extractClickableElementSigs, clickPointerAndCollect } from './click-collector.js';
import { captureNode } from '../utilities/snapshots.js';
import type { NodeState } from '../utilities/types.js';

type CollectorConfig = {
  targetUrl: string;
  loginUrl?: string;
  loginUser: string;
  loginPass: string;
  headful: boolean;
  maxUrls?: number;
  onDiscovered?: (url: string) => Promise<void> | void;
  onBaseCapture?: (node: NodeState) => Promise<void> | void;
};

export async function collectUrlsFromInitialPage(config: CollectorConfig): Promise<string[]> {
  const discoveredUrls = new Set<string>();
  const browser = await chromium.launch({ headless: !config.headful });
  const context = await browser.newContext();
  const t = getTimeoutMs('crawler');
  try { (context as any).setDefaultTimeout?.(t); } catch {}
  try { (context as any).setDefaultNavigationTimeout?.(t); } catch {}

  const page = await context.newPage();
  try { page.setDefaultTimeout(t); } catch {}
  try { page.setDefaultNavigationTimeout(t); } catch {}

  try {
    try { console.info(`[BASE] ${normalizeUrl(config.targetUrl)}`); } catch {}
    const startUrl = config.loginUrl || config.targetUrl;
    await page.goto(startUrl, { waitUntil: 'commit', timeout: t }).catch(() => {});
    try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 10000) }); } catch {}
    await login(page, config);
    await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
    await page.waitForLoadState('load', { timeout: Math.min(10000, t) }).catch(() => {});
    await page.waitForSelector('a[href], [role="link"], .rc-room, .sidebar', { state: 'attached', timeout: Math.min(5000, t) }).catch(() => {});
    await page.waitForTimeout(Math.min(4000, t));

    let node = await capture(page);
    try { console.info(`[ROOT URL] ${node.url}`); } catch {}
    let snapshotUrls = extractInternalUrlsFromSnapshot(node.snapshotForAI, node.url, config.targetUrl);
    if ((!node.snapshotForAI || node.snapshotForAI.trim().length === 0) || snapshotUrls.length === 0) {
      try {
        const base = new URL(config.targetUrl);
        const homeUrl = new URL('/home', `${base.protocol}//${base.host}`).toString();
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: t }).catch(() => {});
        try { await page.waitForLoadState('load', { timeout: Math.min(10000, t) }); } catch {}
        try { await page.waitForSelector('a[href], [role="link"], .rc-room, .sidebar', { state: 'attached', timeout: Math.min(5000, t) }); } catch {}
        await page.waitForTimeout(Math.min(2000, t));
        node = await capture(page);
        try { console.info(`[ROOT URL] ${node.url}`); } catch {}
        snapshotUrls = extractInternalUrlsFromSnapshot(node.snapshotForAI, node.url, config.targetUrl);
      } catch {}
    }
    addUrls(discoveredUrls, snapshotUrls);
    logList('Snapshot URLs', snapshotUrls);

    // 基準シグネチャ（最初のページの /url と クリック可能要素 role|name）
    const baseUrlSet = new Set<string>(snapshotUrls);
    const baseElemSet = extractClickableElementSigs(node.snapshotForAI);
    const path: string[] = ['ROOT'];

    const clickCfg0: any = { targetUrl: config.targetUrl };
    if (typeof config.maxUrls === 'number') clickCfg0.maxUrls = config.maxUrls;
    if (config.onDiscovered) clickCfg0.onDiscovered = config.onDiscovered;
    await clickPointerAndCollect(page, node.snapshotForAI, discoveredUrls, baseUrlSet, baseElemSet, config.targetUrl, path, 0, null, undefined, clickCfg0);

    

    discoveredUrls.add(normalizeUrl(node.url));
    try {
      console.info('[Collected URLs]');
      for (const u of Array.from(discoveredUrls.values()).sort()) console.info(u);
      console.info(`[collectInitialPageUrls] collected ${discoveredUrls.size} internal URLs`);
    } catch {}
    return Array.from(discoveredUrls);
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

// 全ドメイン（同一ホスト）配下のURLをBFSで収集する
// - URL重複は canonicalUrlKey で排除（大文字小文字無視・クエリ/フラグメント無視）
// - クリック対象のグローバル重複（role|name）も排除
export async function collectAllInternalUrls(config: CollectorConfig & { shouldStop?: () => boolean }): Promise<string[]> {
  const discoveredByKey = new Map<string, string>(); // canonicalKey -> normalizedUrl
  const globalElemSigs = new Set<string>();
  // CSV への書き込み件数上限は main 側で制御するため、ここでは max を用いた早期終了は行わない

  const browser = await chromium.launch({ headless: !config.headful });
  const context = await browser.newContext();
  const t = getTimeoutMs('crawler');
  try { (context as any).setDefaultTimeout?.(t); } catch {}
  try { (context as any).setDefaultNavigationTimeout?.(t); } catch {}

  const page = await context.newPage();
  try { page.setDefaultTimeout(t); } catch {}
  try { page.setDefaultNavigationTimeout(t); } catch {}

  try {
    try { console.info(`[BASE] ${normalizeUrl(config.targetUrl)}`); } catch {}
    const startUrl = config.loginUrl || config.targetUrl;
    if (config.shouldStop?.()) return [];
    await page.goto(startUrl, { waitUntil: 'commit', timeout: t }).catch(() => {});
    try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 10000) }); } catch {}
    await login(page, config);
    await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
    await page.waitForLoadState('load', { timeout: Math.min(10000, t) }).catch(() => {});
    await page.waitForSelector('a[href], [role="link"], .rc-room, .sidebar', { state: 'attached', timeout: Math.min(5000, t) }).catch(() => {});
    await page.waitForTimeout(Math.min(4000, t));

    // まず開始ページから収集
    let node = await capture(page);
    const handleDiscovered = async (url: string) => {
      const norm = normalizeUrl(url);
      const key = canonicalUrlKey(norm);
      if (!discoveredByKey.has(key)) discoveredByKey.set(key, norm);
      try { await config.onDiscovered?.(norm); } catch {}
    };

    addUrlsToMapFromSnapshot(discoveredByKey, node, config.targetUrl, handleDiscovered);
    discoveredByKey.set(canonicalUrlKey(node.url), normalizeUrl(node.url));
    try { await config.onBaseCapture?.(await captureNode(page, { depth: 0 })); } catch {}
    // ここでは早期終了しない（CSV 書き込み上限は main 側で制御）

    // ページ内クリックでの増分も加える
    const baseUrlSet = new Set<string>(Array.from(discoveredByKey.values()));
    const baseElemSet = extractClickableElementSigs(node.snapshotForAI);
    const clickCfg: any = { targetUrl: config.targetUrl };
    clickCfg.onDiscovered = handleDiscovered;
    await clickPointerAndCollect(page, node.snapshotForAI, new Set<string>(), baseUrlSet, baseElemSet, config.targetUrl, ['ROOT'], 0, null, globalElemSigs, { ...clickCfg, shouldStop: config.shouldStop })
      .catch(() => {});
    // clickPointerAndCollect 後、念のため再スナップショットからも抽出
    const after = await capture(page);
    addUrlsToMapFromSnapshot(discoveredByKey, after, config.targetUrl, handleDiscovered);
    // ここでも早期終了しない

    

    // BFS: 発見済みURLをキューへ
    const visitedKeys = new Set<string>();
    const queue: string[] = Array.from(new Set(Array.from(discoveredByKey.values())));

    while (queue.length > 0) {
      if (config.shouldStop?.()) break;
      const currentUrl = queue.shift()!;
      const key = canonicalUrlKey(currentUrl);
      if (visitedKeys.has(key)) continue;
      visitedKeys.add(key);

      try {
        if (config.shouldStop?.()) break;
        await page.goto(currentUrl, { waitUntil: 'commit', timeout: t }).catch(() => {});
        try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 10000) }); } catch {}
        await page.waitForLoadState('load', { timeout: Math.min(10000, t) }).catch(() => {});
        await page.waitForTimeout(Math.min(1500, t));

        const n = await capture(page);
        // ベース切替のスナップショットをCSVへ
        try { await config.onBaseCapture?.(await captureNode(page, { depth: 0 })); } catch {}
        addUrlsToMapFromSnapshot(discoveredByKey, n, config.targetUrl, handleDiscovered);

        const baseSet = new Set<string>(Array.from(discoveredByKey.values()));
        const elemSet = extractClickableElementSigs(n.snapshotForAI);
        const clickCfg2: any = { targetUrl: config.targetUrl };
        clickCfg2.onDiscovered = handleDiscovered;
        await clickPointerAndCollect(page, n.snapshotForAI, new Set<string>(), baseSet, elemSet, config.targetUrl, ['ROOT', currentUrl], 0, null, globalElemSigs, { ...clickCfg2, shouldStop: config.shouldStop })
          .catch(() => {});
        // click後の再スナップショットで増分
        const n2 = await capture(page);
        addUrlsToMapFromSnapshot(discoveredByKey, n2, config.targetUrl, handleDiscovered);
        

        

        // 新規のみをキューへ
        for (const v of discoveredByKey.values()) {
          const k = canonicalUrlKey(v);
          if (!visitedKeys.has(k)) queue.push(v);
        }
      } catch (e) {
        try { console.warn(`[BFS] skip due to error navigating ${currentUrl}: ${String((e as any)?.message ?? e)}`); } catch {}
      }
    }

    const final = Array.from(new Set(Array.from(discoveredByKey.values()))).sort();
    try {
      console.info(`[collectAllInternalUrls] total=${final.length}`);
    } catch {}
    return final;
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

function logList(label: string, list: string[]): void {
  try {
    const uniq = Array.from(new Set(list)).sort();
    console.info(`[${label}] internal=${uniq.length}`);
    for (const u of uniq) console.info(`SS: ${u}`);
  } catch {}
}

function addUrlsToMapFromSnapshot(
  store: Map<string, string>,
  node: { snapshotForAI: string; url: string },
  baseUrl: string,
  onDiscovered?: (url: string) => Promise<void> | void,
): void {
  try {
    const urls = extractInternalUrlsFromSnapshot(node.snapshotForAI, node.url, baseUrl);
    for (const u of urls) {
      const key = canonicalUrlKey(u);
      if (!store.has(key)) {
        const norm = normalizeUrl(u);
        store.set(key, norm);
        try { void onDiscovered?.(norm); } catch {}
      }
    }
  } catch {}
}

function addUrls(store: Set<string>, list: string[] | Set<string>): void {
  for (const u of list as any) {
    if (!u) continue;
    store.add(normalizeUrl(u));
  }
}
