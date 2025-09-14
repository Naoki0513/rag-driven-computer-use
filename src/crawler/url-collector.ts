import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { interactionsFromSnapshot } from './interactions.js';
import { getTimeoutMs } from '../utilities/timeout.js';
import { isInternalLink, normalizeUrl, canonicalUrlKey } from '../utilities/url.js';
import fs from 'node:fs';
import path from 'node:path';

type CollectorConfig = {
  targetUrl: string;
  loginUrl?: string;
  loginUser: string;
  loginPass: string;
  headful: boolean;
  urlsOutJsonPath?: string;
  urlsOutTxtPath?: string;
  maxUrls?: number;
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
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: t });
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
    await writeOutputIncremental(discoveredUrls, config).catch(() => {});
    logList('Snapshot URLs', snapshotUrls);

    // 基準シグネチャ（最初のページの /url と クリック可能要素 role|name）
    const baseUrlSet = new Set<string>(snapshotUrls);
    const baseElemSet = extractClickableElementSigs(node.snapshotForAI);
    const path: string[] = ['ROOT'];

    await clickPointerAndCollect(page, node.snapshotForAI, discoveredUrls, baseUrlSet, baseElemSet, config.targetUrl, path, 0, null, undefined, config);

    

    discoveredUrls.add(normalizeUrl(node.url));
    await writeOutputIncremental(discoveredUrls, config).catch(() => {});
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
export async function collectAllInternalUrls(config: CollectorConfig): Promise<string[]> {
  const discoveredByKey = new Map<string, string>(); // canonicalKey -> normalizedUrl
  const globalElemSigs = new Set<string>();
  const max = Number.isFinite(Number(config.maxUrls)) && Number(config.maxUrls) > 0 ? Number(config.maxUrls) : undefined;

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
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: t });
    await login(page, config);
    await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
    await page.waitForLoadState('load', { timeout: Math.min(10000, t) }).catch(() => {});
    await page.waitForSelector('a[href], [role="link"], .rc-room, .sidebar', { state: 'attached', timeout: Math.min(5000, t) }).catch(() => {});
    await page.waitForTimeout(Math.min(4000, t));

    // まず開始ページから収集
    let node = await capture(page);
    addUrlsToMapFromSnapshot(discoveredByKey, node, config.targetUrl);
    discoveredByKey.set(canonicalUrlKey(node.url), normalizeUrl(node.url));
    await writeOutputIncremental(new Set(discoveredByKey.values()), config).catch(() => {});
    if (max && discoveredByKey.size >= max) {
      const resultEarly = Array.from(new Set(Array.from(discoveredByKey.values()))).slice(0, max).sort();
      try { console.info(`[collectAllInternalUrls] reached max=${max}`); } catch {}
      return resultEarly;
    }

    // ページ内クリックでの増分も加える
    const baseUrlSet = new Set<string>(Array.from(discoveredByKey.values()));
    const baseElemSet = extractClickableElementSigs(node.snapshotForAI);
    await clickPointerAndCollect(page, node.snapshotForAI, new Set<string>(), baseUrlSet, baseElemSet, config.targetUrl, ['ROOT'], 0, null, globalElemSigs, config)
      .catch(() => {});
    // clickPointerAndCollect 内でのURL抽出は呼び出し側で行うため、一度再スナップショット
    const after = await capture(page);
    addUrlsToMapFromSnapshot(discoveredByKey, after, config.targetUrl);
    await writeOutputIncremental(new Set(discoveredByKey.values()), config).catch(() => {});
    if (max && discoveredByKey.size >= max) {
      const resultEarly = Array.from(new Set(Array.from(discoveredByKey.values()))).slice(0, max).sort();
      try { console.info(`[collectAllInternalUrls] reached max=${max}`); } catch {}
      return resultEarly;
    }

    

    // BFS: 発見済みURLをキューへ
    const visitedKeys = new Set<string>();
    const queue: string[] = Array.from(new Set(Array.from(discoveredByKey.values())));

    while (queue.length > 0) {
      if (max && discoveredByKey.size >= max) break;
      const currentUrl = queue.shift()!;
      const key = canonicalUrlKey(currentUrl);
      if (visitedKeys.has(key)) continue;
      visitedKeys.add(key);

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: t });
        await page.waitForLoadState('load', { timeout: Math.min(10000, t) }).catch(() => {});
        await page.waitForTimeout(Math.min(1500, t));

        const n = await capture(page);
        addUrlsToMapFromSnapshot(discoveredByKey, n, config.targetUrl);
        await writeOutputIncremental(new Set(discoveredByKey.values()), config).catch(() => {});
        if (max && discoveredByKey.size >= max) break;

        const baseSet = new Set<string>(Array.from(discoveredByKey.values()));
        const elemSet = extractClickableElementSigs(n.snapshotForAI);
        await clickPointerAndCollect(page, n.snapshotForAI, new Set<string>(), baseSet, elemSet, config.targetUrl, ['ROOT', currentUrl], 0, null, globalElemSigs, config)
          .catch(() => {});
        // click後の再スナップショットで増分
        const n2 = await capture(page);
        addUrlsToMapFromSnapshot(discoveredByKey, n2, config.targetUrl);
        await writeOutputIncremental(new Set(discoveredByKey.values()), config).catch(() => {});
        if (max && discoveredByKey.size >= max) break;

        

        // 新規のみをキューへ
        for (const v of discoveredByKey.values()) {
          const k = canonicalUrlKey(v);
          if (!visitedKeys.has(k)) queue.push(v);
        }
      } catch (e) {
        try { console.warn(`[BFS] skip due to error navigating ${currentUrl}: ${String((e as any)?.message ?? e)}`); } catch {}
      }
    }

    const result = Array.from(new Set(Array.from(discoveredByKey.values()))).sort();
    const final = max ? result.slice(0, max) : result;
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

export async function login(page: Page, config: CollectorConfig): Promise<void> {
  const t = getTimeoutMs('crawler');
  await page.goto(config.targetUrl, { waitUntil: 'load', timeout: t }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: t }).catch(() => {});
  await page.waitForTimeout(Math.min(5000, t));
  const isAlreadyLoggedIn = await page.evaluate<boolean>(
    'Boolean(document.querySelector(".sidebar") || document.querySelector(".main-content") || document.querySelector(".rc-room"))',
  );
  if (isAlreadyLoggedIn) return;
  const currentUrl = page.url();
  if (currentUrl.includes('/home')) {
    const baseUrl = config.targetUrl.replace(/\/home\/?$/, '');
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: t }).catch(() => {});
    await page.waitForTimeout(Math.min(2000, t));
  }
  const loginInput = await page.$('input[name="emailOrUsername"], input[name="username"], input[name="email"], input[type="email"], input[type="text"][placeholder*="user" i]');
  const passwordInput = await page.$('input[type="password"]');
  const submitButton = await page.$('button.login, button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")');
  if (loginInput && passwordInput && submitButton) {
    await loginInput.fill(config.loginUser);
    await passwordInput.fill(config.loginPass);
    await submitButton.click({ timeout: t });
    await page.waitForTimeout(Math.min(5000, t));
  }
}

async function capture(page: Page): Promise<{ url: string; snapshotForAI: string }> {
  const { captureNode } = await import('../utilities/snapshots.js');
  const node = await captureNode(page, { depth: 0 });
  return { url: node.url, snapshotForAI: node.snapshotForAI };
}

function logFullSnapshot(_text: string): void {
  // 出力負荷が高くログが流れてしまうため、全文出力は抑止
}

function logList(label: string, list: string[]): void {
  try {
    const uniq = Array.from(new Set(list)).sort();
    console.info(`[${label}] internal=${uniq.length}`);
    for (const u of uniq) console.info(`SS: ${u}`);
  } catch {}
}

function addUrlsToMapFromSnapshot(store: Map<string, string>, node: { snapshotForAI: string; url: string }, baseUrl: string): void {
  try {
    const urls = extractInternalUrlsFromSnapshot(node.snapshotForAI, node.url, baseUrl);
    for (const u of urls) {
      const key = canonicalUrlKey(u);
      if (!store.has(key)) store.set(key, normalizeUrl(u));
    }
  } catch {}
}

function extractInternalUrlsFromSnapshot(snapshotText: string, fromUrl: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const lines = snapshotText.split(/\r?\n/);
  for (const raw of lines) {
    const line = (raw ?? '').trim();
    // /url のみ対象（href は収集しない）
    const m = /(?:\/url\s*:\s*)([^\s]+)/i.exec(line);
    if (!m) continue;
    const rawUrl = (m[1] ?? '').trim();
    if (!rawUrl) continue;
    let abs: string;
    try {
      abs = new URL(rawUrl, fromUrl).toString();
    } catch {
      continue;
    }
    const norm = normalizeUrl(abs);
    if (isInternalLink(norm, baseUrl)) urls.push(norm);
  }
  return Array.from(new Set(urls));
}

function addUrls(store: Set<string>, list: string[] | Set<string>): void {
  for (const u of list as any) {
    if (!u) continue;
    store.add(normalizeUrl(u));
  }
}

function buildFlexibleNameRegex(name: string | null | undefined): RegExp | undefined {
  if (!name) return undefined;
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped.replace(/[_\s]+/g, '\\s*').replace(/-+/g, '[-\\s_]*');
  return new RegExp(flexible, 'i');
}

function extractClickableElementSigs(snapshotText: string): Set<string> {
  const sigs = new Set<string>();
  try {
    // interactionsFromSnapshot を使い、pointerのある役割を抽出
    // 役割: button, link, tab, menuitem（大文字小文字無視）
    const lines = snapshotText.split(/\r?\n/);
    for (const raw of lines) {
      const line = (raw ?? '').trim();
      if (!line.includes('[cursor=pointer]')) continue;
      const m = /^-\s*([A-Za-z]+)\s*(?:"([^"]+)")?/.exec(line);
      if (!m) continue;
      const role = (m[1] || '').toLowerCase();
      const name = (m[2] || '').trim().toLowerCase();
      if (!role) continue;
      if (!['button','link','tab','menuitem'].includes(role)) continue;
      sigs.add(`${role}|${name}`);
    }
  } catch {}
  return sigs;
}

async function clickPointerAndCollect(
  page: Page,
  snapshotText: string,
  discovered: Set<string>,
  baseUrlSet: Set<string>,
  baseElemSet: Set<string>,
  baseUrl: string,
  path: string[],
  level: number,
  firstMutatorSig: string | null = null,
  globalElemSigSet?: Set<string>,
  config?: CollectorConfig,
): Promise<void> {
  const t = getTimeoutMs('crawler');
  const rootUrl = normalizeUrl(page.url());
  const interactions = await interactionsFromSnapshot(snapshotText);
  const allowed = new Set(['button', 'tab', 'menuitem']);
  const candidates = interactions.filter((i) => i.ref && i.role && allowed.has((i.role || '').toLowerCase()));
  try { console.info(`[root=${rootUrl}] [level=${level}] [path=${path.join(' > ')}] candidates=${candidates.length}`); } catch {}
  for (let idx = 0; idx < candidates.length; idx += 1) {
    if (config?.maxUrls && (baseUrlSet.size + discovered.size) >= config.maxUrls) {
      try { console.info(`[root=${rootUrl}] [level=${level}] reached maxUrls=${config.maxUrls}; stop clicking`); } catch {}
      return;
    }
    const it = candidates[idx]!;
    const roleLower = (it.role || '').toLowerCase();
    if (roleLower === 'link') continue;
    const nameRegex = buildFlexibleNameRegex(it.name ?? null);
    const options: Parameters<Page['getByRole']>[1] = {} as any;
    if (nameRegex) (options as any).name = nameRegex;
    const labelName = (it.name || '').replace(/\s+/g, ' ').trim();
    const refStr = it.ref || it.refId || 'n/a';
    const pos = idx + 1;
    try { console.info(`[root=${rootUrl}] [level=${level}] [path=${path.join(' > ')}] try role=${it.role} name="${labelName}" ref=${refStr} idx=${pos}/${candidates.length}`); } catch {}

    const sig = `${roleLower}|${labelName}`.toLowerCase();
    if (level > 0 && baseElemSet.has(sig)) {
      try { console.info(`[root=${rootUrl}] [level=${level}] skip same base element sig=${sig}`); } catch {}
      continue;
    }
    if (globalElemSigSet && globalElemSigSet.has(sig)) {
      try { console.info(`[root=${rootUrl}] [level=${level}] skip global duplicate element sig=${sig}`); } catch {}
      continue;
    }
    if (globalElemSigSet) {
      // このセッションで一度だけクリックするため予約
      globalElemSigSet.add(sig);
    }

    // 事前に href(/url) が既知か判定し、既知ならクリックを省略
    let predictedAbs: string | null = null;
    try {
      const hrefOrUrl = (it as any).href as string | null | undefined;
      if (hrefOrUrl) {
        predictedAbs = normalizeUrl(new URL(hrefOrUrl, rootUrl).toString());
      }
    } catch {}
    if (predictedAbs && isInternalLink(predictedAbs, baseUrl)) {
      if (baseUrlSet.has(predictedAbs) || discovered.has(predictedAbs)) {
        try { console.info(`[root=${rootUrl}] [level=${level}] skip click; predicted URL already known -> ${predictedAbs}`); } catch {}
        continue;
      }
      // 新規URLとして先に登録し、クリックは省略
      discovered.add(predictedAbs);
      try { console.info(`[root=${rootUrl}] [level=${level}] add new URL from href without click -> ${predictedAbs}`); } catch {}
      if (config) {
        await writeOutputIncremental(discovered, config).catch(() => {});
      }
      continue;
    }

    try {
      const locator = page.getByRole(it.role as any, options as any).first();
      let isVisible = false;
      let isEnabled = false;
      try { isVisible = await locator.isVisible(); } catch {}
      try { isEnabled = await locator.isEnabled(); } catch {}
      try { console.info(`[root=${rootUrl}] [level=${level}] diagnostics visible=${isVisible} enabled=${isEnabled}`); } catch {}
      try { await locator.waitFor({ state: 'visible', timeout: Math.min(t, 2000) }); } catch { continue; }

      const urlWaiter = page
        .waitForFunction((prev) => window.location.href !== prev, rootUrl, { timeout: Math.min(t, 3000) })
        .then(() => true)
        .catch(() => false);

      await locator.click({ timeout: Math.min(t, 2000) });
      const changed = await urlWaiter;

      if (changed) {
        const newUrl = normalizeUrl(page.url());
        try { console.info(`[root=${rootUrl}] [level=${level}] URL changed -> ${newUrl}`); } catch {}
        if (isInternalLink(newUrl, baseUrl)) discovered.add(newUrl);
        if (config) {
          await writeOutputIncremental(discovered, config).catch(() => {});
        }
        try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 5000) }); } catch {}
      } else {
        try { console.info(`[root=${rootUrl}] [level=${level}] no URL change; capturing snapshot for diff`); } catch {}
      }

      const full = await capture(page);
      const snapUrls = extractInternalUrlsFromSnapshot(full.snapshotForAI, full.url, baseUrl);
      const newUrls = snapUrls.filter((u) => !baseUrlSet.has(u));
      addUrls(discovered, newUrls);
      if (config) {
        await writeOutputIncremental(discovered, config).catch(() => {});
        if (config.maxUrls && (baseUrlSet.size + discovered.size) >= config.maxUrls) {
          try { console.info(`[root=${rootUrl}] [level=${level}] reached maxUrls=${config.maxUrls}; stop recursion`); } catch {}
          return;
        }
      }
      logList(changed ? 'Snapshot URLs(after nav)' : 'Snapshot URLs(after click)', snapUrls);

      const newElemSigs = extractClickableElementSigs(full.snapshotForAI);
      const novelElems = Array.from(newElemSigs).filter((s) => !baseElemSet.has(s));
      try { console.info(`[root=${rootUrl}] [level=${level}] new clickable elements after click: ${novelElems.length}`); for (const s of novelElems) console.info(`NEW-ELEM: ${s}`); } catch {}
      if (globalElemSigSet) {
        for (const s of novelElems) globalElemSigSet.add(s.toLowerCase());
      }

      if (changed) {
        try { console.info(`[root=${rootUrl}] [level=${level}] returning to original via reload -> ${rootUrl}`); } catch {}
        await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(t, 6000) }).catch(() => {});
        try { await page.waitForTimeout(200); } catch {}
      } else if (novelElems.length > 0) {
        const childBaseElems = new Set<string>([...baseElemSet, ...newElemSigs]);
        const childPath = [...path, `${it.role}:${labelName}`];
        await clickPointerAndCollect(page, full.snapshotForAI, discovered, new Set([...baseUrlSet, ...newUrls]), childBaseElems, baseUrl, childPath, level + 1, null, globalElemSigSet, config);
        // レベル1探索を終えてレベル0に戻る場合は、基底URLを再読み込みして状態をリセット
        if (level === 0) {
          try { console.info(`[root=${rootUrl}] [level=${level}] reload after level-1 exploration -> ${rootUrl}`); } catch {}
          try { await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(t, 6000) }); } catch {}
          try { await page.waitForTimeout(200); } catch {}
        }
      }

    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      try { console.warn(`[root=${rootUrl}] [level=${level}] click failed role=${it.role} name="${labelName}" ref=${refStr} reason=${msg}`); } catch {}
    }
  }
}

// MutationObserver を使用していた補助関数は削除しました（差分検出方式へ移行）。

async function writeOutput(discovered: Set<string>, config: CollectorConfig): Promise<void> {
  // 互換のため残置（全書き換え）。現在は writeOutputIncremental を優先して使用。
  await writeOutputIncremental(discovered, config);
}

async function writeOutputIncremental(discovered: Set<string> | Iterable<string>, config: CollectorConfig): Promise<void> {
  const jsonPath = config.urlsOutJsonPath || 'output/urls.json';
  const txtPath = config.urlsOutTxtPath || 'output/urls.txt';
  await fs.promises.mkdir(path.dirname(jsonPath), { recursive: true }).catch(() => {});
  await fs.promises.mkdir(path.dirname(txtPath), { recursive: true }).catch(() => {});

  const currentSet = new Set<string>();
  try {
    const raw = await fs.promises.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const existing: string[] = Array.isArray(parsed?.urls) ? parsed.urls : [];
    for (const u of existing) if (u) currentSet.add(normalizeUrl(u));
  } catch {}
  try {
    const rawTxt = await fs.promises.readFile(txtPath, 'utf8');
    for (const line of (rawTxt || '').split(/\r?\n/)) {
      const u = (line || '').trim();
      if (!u) continue;
      currentSet.add(normalizeUrl(u));
    }
  } catch {}

  for (const u of discovered as any) {
    if (!u) continue;
    currentSet.add(normalizeUrl(u));
  }

  const urlsArray = Array.from(currentSet.values()).sort();
  const payload = {
    startUrl: config.loginUrl || config.targetUrl,
    collectedAt: new Date().toISOString(),
    count: urlsArray.length,
    urls: urlsArray,
  };
  await fs.promises.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.promises.writeFile(txtPath, urlsArray.join('\n') + '\n', 'utf8');
}

 


