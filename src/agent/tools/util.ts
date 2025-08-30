import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { captureNode } from '../../utilities/snapshots.js';

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
  sharedPage = await sharedContext.newPage();
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




