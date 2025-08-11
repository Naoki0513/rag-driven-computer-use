import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createDriver, initDatabase, saveNode, createRelation, closeDriver } from './database.js';
import type { NodeState, QueueItem, Interaction } from './types.js';
import { interactionsFromSnapshot, processInteraction } from './interactions.js';
import { gatherWithBatches, normalizeUrl, buildUrl } from './utils.js';

export class WebCrawler {
  private config: any;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private visitedHashes = new Set<string>();
  private queue: QueueItem[] = [];
  private driver: import('neo4j-driver').Driver | null = null;
  private triedActions = new Set<string>();
  private noDiscoveryStreak = 0;

  constructor(config: any) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      this.driver = await createDriver(this.config.neo4jUri, this.config.neo4jUser, this.config.neo4jPassword);
      if (this.config.clearDb) await initDatabase(this.driver);
    } catch (e) {
      console.warn('Neo4j initialization skipped:', (e as Error).message);
      this.driver = null;
    }

    this.browser = await chromium.launch({ headless: !this.config.headful });
    this.context = await this.browser.newContext();
  }

  async cleanup(): Promise<void> {
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    try { await closeDriver(this.driver); } catch {}
  }

  async run(): Promise<void> {
    if (!this.context) throw new Error('Context not initialized');
    const page = await this.context.newPage();
    let visitedCount = 0;
    try {
      await page.goto(this.config.targetUrl, { waitUntil: 'networkidle' });
      const preLoginNode = await this.captureAndStore(page);
      this.visitedHashes.add(preLoginNode.snapshotHash);
      visitedCount += 1;

      await this.login(page);

      const postLoginNode = await this.captureAndStore(page);
      if (this.driver) {
        await createRelation(this.driver, preLoginNode, postLoginNode, { actionType: 'submit', ref: null, href: null, role: null, name: null });
      }
      this.visitedHashes.add(postLoginNode.snapshotHash);
      this.queue.push({ node: postLoginNode, depth: 0 });
      visitedCount += 1;

      const exhaustive = !!this.config.exhaustive;
      while (this.queue.length > 0) {
        // Stop gracefully if context is gone
        if (!this.context || (typeof (this.context as any).isClosed === 'function' && (this.context as any).isClosed())) {
          console.info('Browser context closed; stopping crawl loop.');
          break;
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
        if (page.isClosed()) {
          console.info('Main page closed; stopping crawl loop.');
          break;
        } else {
          try {
            const currentUrl = buildUrl(current.node.site, current.node.route);
            await page.goto(currentUrl, { waitUntil: 'networkidle' });
            await page.waitForTimeout(5000);
          } catch (e) {
            const msg = String((e as Error)?.message ?? '');
            if (msg.includes('Target page') || msg.includes('has been closed')) {
              console.info('Main page was closed; stopping crawl loop gracefully.');
              break;
            }
            // non-fatal navigation issues: skip this state
            console.warn('Navigation failed, skipping state:', msg);
            continue;
          }
        }

          const interactions = await interactionsFromSnapshot(current.node.snapshotForAI);
          // 1ページあたり全要素を対象にする（並列度は parallelTasks で制御）
          const tasks = interactions.map((interaction) => async () => {
          if (!this.context) return null;
          const newNode = await processInteraction(this.context, current.node, interaction, {
            ...this.config,
            visitedHashes: this.visitedHashes,
            triedActions: this.triedActions,
          });
           if (newNode) {
             const hash = newNode.snapshotHash;
            if (!this.visitedHashes.has(hash)) {
               await this.storeNodeAndEdge(current.node, newNode, interaction);
                this.visitedHashes.add(hash);
              this.queue.push({ node: newNode, depth: current.depth + 1 });
              visitedCount += 1;
              this.noDiscoveryStreak = 0;
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

  private async captureAndStore(page: Page): Promise<NodeState> {
    const { captureNode } = await import('./snapshots.js');
    const node = await captureNode(page);
    try {
      const preview = node.snapshotForAI.slice(0, 200).replace(/\s+/g, ' ');
      console.info(`[snapshotForAI] ${preview}${node.snapshotForAI.length > 200 ? '…' : ''}`);
    } catch {}
    if (this.driver) await saveNode(this.driver, node);
    return node;
  }

  private async storeNodeAndEdge(fromNode: NodeState, newNode: NodeState, interaction: Interaction): Promise<void> {
    if (!this.driver) return;
    await saveNode(this.driver, newNode);
    await createRelation(this.driver, fromNode, newNode, {
      actionType: interaction.actionType,
      ref: interaction.ref ?? interaction.refId ?? null,
      href: interaction.href ?? null,
      role: interaction.role ?? null,
      name: interaction.name ?? null,
    });
  }

  private async login(page: Page): Promise<void> {
    await page.goto(this.config.targetUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000);

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
      await page.goto(baseUrl, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const loginInput = await page.$('input[name="emailOrUsername"], input[name="username"], input[name="email"], input[type="email"], input[type="text"][placeholder*="user" i]');
    const passwordInput = await page.$('input[type="password"]');
    const submitButton = await page.$('button.login, button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")');

    if (loginInput && passwordInput && submitButton) {
      await loginInput.fill(this.config.loginUser);
      await passwordInput.fill(this.config.loginPass);
      await submitButton.click();
      await page.waitForTimeout(5000);
      const isLoggedIn = await page.evaluate<boolean>(
        'Boolean(document.querySelector(".sidebar") || document.querySelector(".main-content") || document.querySelector(".rc-room"))',
      );
      if (isLoggedIn) console.info('Login successful');
      else console.warn('Login confirmation elements not found');
    } else {
      console.info('Login form not found, continuing');
    }
  }
}


