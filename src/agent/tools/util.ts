import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Locator } from 'playwright';
import { captureNode } from '../../utilities/snapshots.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

// 共有ブラウザ管理（単一の Browser/Context/Page を使い回す）
let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;

export async function ensureSharedBrowserStarted(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (sharedBrowser && sharedContext && sharedPage) {
    return { browser: sharedBrowser, context: sharedContext, page: sharedPage };
  }
  const headful = String(process.env.AGENT_HEADFUL ?? 'false').toLowerCase() === 'true';
  sharedBrowser = await chromium.launch({ headless: !headful });
  sharedContext = await sharedBrowser.newContext();
  const t = getTimeoutMs('agent');
  try { (sharedContext as any).setDefaultTimeout?.(t); } catch {}
  try { (sharedContext as any).setDefaultNavigationTimeout?.(t); } catch {}
  sharedPage = await sharedContext.newPage();
  try { sharedPage.setDefaultTimeout(t); } catch {}
  try { sharedPage.setDefaultNavigationTimeout(t); } catch {}
  console.log('[OK] 共有 Playwright ブラウザを起動しました');
  return { browser: sharedBrowser, context: sharedContext, page: sharedPage };
}

export async function closeSharedBrowserWithDelay(delayMs?: number): Promise<void> {
  const ms = Number.isFinite(Number(process.env.AGENT_BROWSER_CLOSE_DELAY_MS))
    ? Number(process.env.AGENT_BROWSER_CLOSE_DELAY_MS)
    : (typeof delayMs === 'number' ? delayMs : 5000);
  if (sharedBrowser) {
    try {
      console.log(`ブラウザを ${ms}ms 後にクローズします...`);
      await new Promise((r) => setTimeout(r, ms));
      await sharedBrowser.close();
      console.log('ブラウザをクローズしました');
    } catch (e: any) {
      console.log(`ブラウザクローズ時エラー: ${String(e?.message ?? e)}`);
    } finally {
      sharedBrowser = null;
      sharedContext = null;
      sharedPage = null;
    }
  }
}

export async function takeSnapshots(page: Page): Promise<{ text: string; hash: string; url: string }> {
  // クローラと同一の取得手順（networkidle 待機 + 追加待機）で撮影する
  const node = await captureNode(page, { depth: 0 });
  return { text: node.snapshotForAI, hash: node.snapshotHash, url: node.url };
}

// エラーメッセージを一貫フォーマット（短く、先頭に識別可能な接頭辞）
export function formatToolError(err: unknown, maxLen: number = 180): string {
  const raw = typeof err === 'string' ? err : String((err as any)?.message ?? err);
  const msg = raw.replace(/\s+/g, ' ').trim();
  const head = msg.length > maxLen ? msg.slice(0, maxLen).trimEnd() + '…' : msg;
  return `エラー: ${head}`;
}

// resolveLocatorByRef は後方互換不要のため削除しました。

// クリック専用の堅牢フォールバック（スクロール→関連label→force）
export async function clickWithFallback(
  page: Page,
  locator: Locator,
  isCheckbox: boolean,
  attemptTimeoutMs?: number,
): Promise<void> {
  const envTimeout = getTimeoutMs('agent');
  const t = Number.isFinite(Number(attemptTimeoutMs)) && Number(attemptTimeoutMs) > 0
    ? Math.trunc(Number(attemptTimeoutMs))
    : envTimeout;
  // checkbox は label クリックを最優先に試す（長い待ちを避ける）
  if (isCheckbox) {
    try {
      const id = await locator.getAttribute('id');
      if (id) {
        const labelByFor = page.locator(`label[for="${id}"]`).first();
        if (await labelByFor.count()) {
          await labelByFor.scrollIntoViewIfNeeded();
          await labelByFor.click({ timeout: t });
          return;
        }
      }
      const ancestorLabel = locator.locator('xpath=ancestor::label').first();
      if (await ancestorLabel.count()) {
        await ancestorLabel.scrollIntoViewIfNeeded();
        await ancestorLabel.click({ timeout: t });
        return;
      }
    } catch {}
  }

  // 1) 通常クリック（短いタイムアウト）
  try { await locator.click({ timeout: t }); return; } catch {}

  // 2) スクロールして再試行（短いタイムアウト）
  try { await locator.scrollIntoViewIfNeeded(); await locator.click({ timeout: t }); return; } catch {}

  // 3) checkbox なら最後にもう一度 label 経由を試す
  if (isCheckbox) {
    try {
      const id = await locator.getAttribute('id');
      if (id) {
        const labelByFor = page.locator(`label[for="${id}"]`).first();
        if (await labelByFor.count()) {
          await labelByFor.scrollIntoViewIfNeeded();
          await labelByFor.click({ timeout: t });
          return;
        }
      }
      const ancestorLabel = locator.locator('xpath=ancestor::label').first();
      if (await ancestorLabel.count()) {
        await ancestorLabel.scrollIntoViewIfNeeded();
        await ancestorLabel.click({ timeout: t });
        return;
      }
    } catch {}
  }

  // 4) 最終手段: force クリック（無条件に実行）
  await locator.click({ force: true });
}




