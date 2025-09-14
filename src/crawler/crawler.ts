import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { NodeState, QueueItem, Interaction } from '../utilities/types.js';
import { interactionsFromSnapshot, processInteraction } from './interactions.js';
import { gatherWithBatches } from '../utilities/async.js';
import { isInternalLink, normalizeUrl } from '../utilities/url.js';
import { getTimeoutMs } from '../utilities/timeout.js';
import { CsvWriter } from '../utilities/csv.js';
import fs from 'node:fs';
import path from 'node:path';

export class WebCrawler {
  private config: any;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private visitedHashes = new Set<string>();
  private queue: QueueItem[] = [];
  private triedActions = new Set<string>();
  private noDiscoveryStreak = 0;
  private csv: CsvWriter | null = null;
  private loginPageHash: string | null = null;
  private visitedUrls = new Set<string>();
  private discoveredUrls = new Set<string>();

  constructor(config: any) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({ headless: !this.config.headful });
    this.context = await this.browser.newContext();
    const t = getTimeoutMs('crawler');
    try { (this.context as any).setDefaultTimeout?.(t); } catch {}
    try { (this.context as any).setDefaultNavigationTimeout?.(t); } catch {}

    // 既存クロール用のCSVは collectUrlsOnly モードでは作成しない
    if (!this.config.collectUrlsOnly) {
      this.csv = new CsvWriter(this.config.csvPath, [
        'URL',
        'id',
        'site',
        'snapshotfor AI',
        'snapshotin MD',
        'timestamp',
      ], { clear: !!this.config.clearCsv });
      await this.csv.initialize();
    }
  }

  async cleanup(): Promise<void> {
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    try { await this.csv?.close(); } catch {}
  }

  async run(): Promise<void> {
    if (!this.context) throw new Error('Context not initialized');
    const page = await this.context.newPage();
    try { page.setDefaultTimeout(getTimeoutMs('crawler')); } catch {}
    try { page.setDefaultNavigationTimeout(getTimeoutMs('crawler')); } catch {}
    let visitedCount = 0;
    try {
      const firstUrl = this.config.loginUrl || this.config.targetUrl;
      await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: getTimeoutMs('crawler') });

      // ログインを先に完了させる（初回スナップショットはログイン後の状態で取得）
      await this.login(page);

      const postLoginNode = await this.captureAndStore(page, 0);
      this.visitedHashes.add(postLoginNode.snapshotHash);
      if (!this.visitedUrls.has(postLoginNode.url)) this.visitedUrls.add(postLoginNode.url);
      this.queue.push({ node: postLoginNode, depth: 0 });
      visitedCount += 1;

      const exhaustive = !!this.config.exhaustive;
      while (this.queue.length > 0) {
        // Stop gracefully if context is gone
        if (!this.context || ((this.context as any).isClosed && (this.context as any).isClosed())) {
          throw new Error('Browser context closed');
        }
        // Early stop if discovery stagnates significantly
        if (!exhaustive && this.noDiscoveryStreak >= Math.max(3, Math.ceil(this.config.maxDepth / 2))) {
          console.info(`Early stop due to saturation. No new pages discovered in ${this.noDiscoveryStreak} iterations.`);
          break;
        }
        if (!exhaustive && visitedCount >= this.config.maxStates) {
          console.info(`Reached max states limit ${this.config.maxStates}`);
          break;
        }
        const current = this.queue.shift()!;
        if (!exhaustive && current.depth >= this.config.maxDepth) continue;

        // Ensure main page is open
        if (page.isClosed()) throw new Error('Main page closed');
        const currentUrl = current.node.url;
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: getTimeoutMs('crawler') });
        await page.waitForLoadState('load', { timeout: Math.min(10000, getTimeoutMs('crawler')) }).catch(() => {});
        await page.waitForTimeout(Math.min(1500, getTimeoutMs('crawler')));

        const interactions = await interactionsFromSnapshot(current.node.snapshotForAI);
        // 1ページあたり全要素を対象にする（並列度は parallelTasks で制御）
        const tasks = interactions.map((interaction) => async () => {
          if (!exhaustive && visitedCount >= this.config.maxStates) {
            return null;
          }
          if (!this.context) return null;
          const newNode = await processInteraction(this.context, current.node, interaction, {
            ...this.config,
            visitedHashes: this.visitedHashes,
            triedActions: this.triedActions,
            visitedUrls: this.visitedUrls,
          });
          if (newNode) {
            const hash = newNode.snapshotHash;
            if (this.visitedUrls.has(newNode.url)) {
              return null; // URL重複は排除
            }
            if (!this.visitedHashes.has(hash)) {
              if (!exhaustive && visitedCount >= this.config.maxStates) {
                return null;
              }
              // 新しいノードの深度を設定し、保存前に反映
              newNode.depth = current.node.depth + 1;
              await this.storeNode(newNode);
              this.visitedHashes.add(hash);
              this.visitedUrls.add(newNode.url);
              this.queue.push({ node: newNode, depth: current.depth + 1 });
              visitedCount += 1;
              this.noDiscoveryStreak = 0;
            } else {
              // 既知ノード（重複スナップショット）の場合、リレーションは保存しない
              // 要件: ノードが被ったら、そのリレーションシップはDBに格納しない
            }
          }
          return newNode;
        });

        const results = await gatherWithBatches(tasks, this.config.parallelTasks);
        const discovered = results.filter((n) => n !== null).length;
        if (discovered === 0) this.noDiscoveryStreak += 1;
        else this.noDiscoveryStreak = 0;
      }
    } finally {
      try { await page.close(); } catch {}
      console.info(`Crawl completed! Total states: ${visitedCount}`);
    }
  }

  // =========================
  // URL収集（初期ページのみ、非遷移）
  // =========================
  async collectInitialPageUrls(): Promise<void> {
    if (!this.context) throw new Error('Context not initialized');
    const page = await this.context.newPage();
    try { page.setDefaultTimeout(getTimeoutMs('crawler')); } catch {}
    try { page.setDefaultNavigationTimeout(getTimeoutMs('crawler')); } catch {}

    const startUrl = this.config.loginUrl || this.config.targetUrl;
    const t = getTimeoutMs('crawler');
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: t });
    await this.login(page);
    await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
    await page.waitForLoadState('load', { timeout: Math.min(10000, t) }).catch(() => {});
    await page.waitForSelector('a[href], [role="link"], .rc-room, .sidebar', { state: 'attached', timeout: Math.min(5000, t) }).catch(() => {});
    await page.waitForTimeout(Math.min(4000, t));

    // 1) スナップショットから /url と href を抽出（内部ドメインのみに限定）
    let node = await this.captureForUrlCollection(page);
    try {
      console.info('[FULL snapshotForAI BEGIN]');
      console.info(node.snapshotForAI);
      console.info('[FULL snapshotForAI END]');
    } catch {}
    let snapshotUrls = this.extractInternalUrlsFromSnapshot(node.snapshotForAI, node.url);
    // スナップショットが空、またはURLが極端に少ない場合は /home にフォールバックして再取得
    if ((!node.snapshotForAI || node.snapshotForAI.trim().length === 0) || snapshotUrls.length === 0) {
      try {
        const base = new URL(this.config.targetUrl);
        const homeUrl = new URL('/home', `${base.protocol}//${base.host}`).toString();
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: t }).catch(() => {});
        try { await page.waitForLoadState('load', { timeout: Math.min(10000, t) }); } catch {}
        try { await page.waitForSelector('a[href], [role="link"], .rc-room, .sidebar', { state: 'attached', timeout: Math.min(5000, t) }); } catch {}
        await page.waitForTimeout(Math.min(2000, t));
        node = await this.captureForUrlCollection(page);
        snapshotUrls = this.extractInternalUrlsFromSnapshot(node.snapshotForAI, node.url);
        try {
          console.info('[FALLBACK to /home]');
          console.info('[FULL snapshotForAI BEGIN]');
          console.info(node.snapshotForAI);
          console.info('[FULL snapshotForAI END]');
        } catch {}
      } catch {}
    }
    this.addUrls(snapshotUrls);
    try {
      const list = Array.from(new Set(snapshotUrls)).sort();
      console.info(`[Snapshot URLs] internal=${list.length}`);
      for (const u of list) console.info(`SS: ${u}`);
    } catch {}

    // 2) [cursor=pointer] なボタン等をクリックし、URLが変わったら取得して即座に元URLへ戻す
    // 1.5) DOMからのhrefも内部のみ取得（スナップショットとの差分観測に利用）
    const domUrls = await this.extractInternalUrlsFromDom(page, node.url).catch(() => [] as string[]);
    try {
      const list = Array.from(new Set(domUrls.map((u) => normalizeUrl(u)))).sort();
      console.info(`[DOM hrefs] internal=${list.length}`);
      for (const u of list) console.info(`DOM: ${u}`);
      this.addUrls(list);
    } catch {}

    await this.clickPointerElementsAndCollectUrls(page, node.snapshotForAI, new Set([...snapshotUrls, ...domUrls]));

    // 3) 自ページ（ログイン後初期ページ）自身のURLも含める
    this.discoveredUrls.add(normalizeUrl(node.url));

    // 4) 出力
    await this.writeDiscoveredUrls();
    try {
      console.info('[Collected URLs]');
      for (const u of Array.from(this.discoveredUrls.values()).sort()) console.info(u);
      console.info(`[collectInitialPageUrls] collected ${this.discoveredUrls.size} internal URLs`);
    } catch {}
  }

  private async captureForUrlCollection(page: Page): Promise<NodeState> {
    const { captureNode } = await import('../utilities/snapshots.js');
    return captureNode(page, { depth: 0 });
  }

  private extractInternalUrlsFromSnapshot(snapshotText: string, fromUrl: string): string[] {
    const urls: string[] = [];
    const lines = snapshotText.split(/\r?\n/);
    for (const raw of lines) {
      const line = (raw ?? '').trim();
      // '/url:' または 'href:' を拾う（/url は単語境界を持たないため \b は使わない）
      const m = /(?:(?:href|\/url)\s*:\s*)([^\s]+)/i.exec(line);
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
      if (isInternalLink(norm, this.config.targetUrl)) urls.push(norm);
    }
    return urls;
  }

  private addUrls(list: string[] | Set<string>): void {
    for (const u of list as any) {
      if (!u) continue;
      this.discoveredUrls.add(normalizeUrl(u));
    }
  }

  private buildFlexibleNameRegex(name: string | null | undefined): RegExp | undefined {
    if (!name) return undefined;
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexible = escaped.replace(/[_\s]+/g, '\\s*').replace(/-+/g, '[-\\s_]*');
    return new RegExp(flexible, 'i');
  }

  private async extractInternalUrlsFromDom(page: Page, fromUrl: string): Promise<string[]> {
    const hrefs: string[] = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).getAttribute('href') || '') );
    const abs = hrefs
      .map((u) => { try { return new URL(u, fromUrl).toString(); } catch { return null; } })
      .filter((u): u is string => !!u);
    const internal = abs
      .map((u) => normalizeUrl(u))
      .filter((u) => isInternalLink(u, (globalThis as any).process?.env?.CRAWLER_TARGET_URL || this.config.targetUrl));
    return Array.from(new Set(internal));
  }

  private async clickPointerElementsAndCollectUrls(page: Page, snapshotText: string, knownInternalUrls: Set<string>): Promise<void> {
    const t = getTimeoutMs('crawler');
    const interactions = await interactionsFromSnapshot(snapshotText);
    const allowed = new Set(['link', 'button', 'tab', 'menuitem']);
    const candidates = interactions.filter((i) => i.ref && i.role && allowed.has((i.role || '').toLowerCase()));

    const originalUrl = normalizeUrl(page.url());
    for (const it of candidates) {
      if (!it.role) continue;
      // 既にスナップショットで内部URLが特定できていればクリック不要
      if (it.href) {
        try {
          const abs = normalizeUrl(new URL(it.href, originalUrl).toString());
          if (isInternalLink(abs, this.config.targetUrl)) {
            if (!this.discoveredUrls.has(abs)) this.discoveredUrls.add(abs);
            if (knownInternalUrls.has(abs)) continue; // 既知URLはクリックしない
          }
        } catch {}
      }
      const nameRegex = this.buildFlexibleNameRegex(it.name ?? null);
      const options: Parameters<Page['getByRole']>[1] = {} as any;
      if (nameRegex) (options as any).name = nameRegex;
      try {
        const locator = page.getByRole(it.role as any, options as any).first();
        await locator.waitFor({ state: 'visible', timeout: Math.min(t, 5000) });

        const waitChanged = page.waitForFunction(
          (prev) => window.location.href !== prev,
          originalUrl,
          { timeout: Math.min(t, 5000) },
        ).then(() => true).catch(() => false);

        await locator.click({ timeout: Math.min(t, 5000) });
        const changed = await waitChanged;
        if (changed) {
          const newUrl = normalizeUrl(page.url());
          if (isInternalLink(newUrl, this.config.targetUrl)) this.discoveredUrls.add(newUrl);
          // 直ちに元URLへ戻す
          await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(t, 8000) }).catch(() => {});
          await page.waitForTimeout(300).catch(() => {});
        }
      } catch (_e) {
        // 見つからない/クリック不可はスキップ
      }
    }
  }

  private async writeDiscoveredUrls(): Promise<void> {
    const jsonPath = this.config.urlsOutJsonPath || 'output/urls.json';
    const txtPath = this.config.urlsOutTxtPath || 'output/urls.txt';
    await fs.promises.mkdir(path.dirname(jsonPath), { recursive: true }).catch(() => {});
    await fs.promises.mkdir(path.dirname(txtPath), { recursive: true }).catch(() => {});
    const urlsArray = Array.from(this.discoveredUrls.values()).sort();
    const payload = {
      startUrl: this.config.loginUrl || this.config.targetUrl,
      collectedAt: new Date().toISOString(),
      count: urlsArray.length,
      urls: urlsArray,
    };
    await fs.promises.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.promises.writeFile(txtPath, urlsArray.join('\n') + '\n', 'utf8');
  }

  private async captureAndStore(page: Page, depth: number): Promise<NodeState> {
    const { captureNode } = await import('../utilities/snapshots.js');
    const node = await captureNode(page, { depth });
    try {
      const preview = node.snapshotForAI.slice(0, 200).replace(/\s+/g, ' ');
      console.info(`[snapshotForAI] ${preview}${node.snapshotForAI.length > 200 ? '…' : ''}`);
      const mdPreview = (node.snapshotInMd || '').slice(0, 200).replace(/\s+/g, ' ');
      if (mdPreview) console.info(`[snapshotInMd] ${mdPreview}${(node.snapshotInMd || '').length > 200 ? '…' : ''}`);
    } catch {}
    if (!this.visitedUrls.has(node.url)) await this.writeNodeToCsv(node);
    return node;
  }

  private async storeNode(newNode: NodeState): Promise<void> {
    await this.writeNodeToCsv(newNode);
  }

  private async login(page: Page): Promise<void> {
    const t = getTimeoutMs('crawler');
    await page.goto(this.config.targetUrl, { waitUntil: 'load', timeout: t }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: t }).catch(() => {});
    await page.waitForTimeout(Math.min(5000, t));

    const isAlreadyLoggedIn = await page.evaluate<boolean>(
      'Boolean(document.querySelector(".sidebar") || document.querySelector(".main-content") || document.querySelector(".rc-room"))',
    );
    if (isAlreadyLoggedIn) {
      console.info('Already logged in');
      return;
    }

    const currentUrl = page.url();
    if (currentUrl.includes('/home')) {
      const baseUrl = this.config.targetUrl.replace(/\/home\/?$/, '');
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: t }).catch(() => {});
      await page.waitForTimeout(Math.min(2000, t));
    }

    const loginInput = await page.$('input[name="emailOrUsername"], input[name="username"], input[name="email"], input[type="email"], input[type="text"][placeholder*="user" i]');
    const passwordInput = await page.$('input[type="password"]');
    const submitButton = await page.$('button.login, button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")');

    if (loginInput && passwordInput && submitButton) {
      await loginInput.fill(this.config.loginUser);
      await passwordInput.fill(this.config.loginPass);
      await submitButton.click({ timeout: t });
      await page.waitForTimeout(Math.min(5000, t));
      const isLoggedIn = await page.evaluate<boolean>(
        'Boolean(document.querySelector(".sidebar") || document.querySelector(".main-content") || document.querySelector(".rc-room"))',
      );
      if (isLoggedIn) console.info('Login successful');
      else console.warn('Login confirmation elements not found');
    } else {
      console.info('Login form not found, continuing');
    }
  }

  private async writeNodeToCsv(node: NodeState): Promise<void> {
    await this.csv?.appendNode(node);
  }
}


