import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { getSnapshotForAI } from '../../utilities/snapshots.js';
import { findRoleAndNameByRef, computeSha256Hex } from '../../utilities/text.js';

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

export async function takeSnapshots(page: Page): Promise<{ text: string; hash: string }> {
  // ページ遷移直後や動的描画直後にスナップショットが空になるのを防ぐため、待機とリトライを行う
  const tryOnce = async (): Promise<string> => {
    try {
      return await getSnapshotForAI(page);
    } catch (e: any) {
      // 一度だけ強めの待機を入れて再試行
      try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
      try { await page.waitForTimeout(1500); } catch {}
      return await getSnapshotForAI(page);
    }
  };
  const text = await tryOnce();
  const hash = computeSha256Hex(text);
  return { text, hash };
}

export async function resolveLocatorByRef(page: Page, ref: string) {
  const snapText = await getSnapshotForAI(page);
  const roleName = findRoleAndNameByRef(snapText, ref);
  if (!roleName) throw new Error(`ref=${ref} に対応する要素が見つかりません (現在のスナップショット)`);
  const { role, name } = roleName;
  const locator = name && name.trim().length > 0
    ? page.getByRole(role as any, { name, exact: true } as any)
    : page.getByRole(role as any);
  await locator.first().waitFor({ state: 'visible', timeout: 30000 });
  return { locator, role, name } as const;
}




