import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Locator } from 'playwright';
import { captureNode, getSnapshotForAI } from '../../utilities/snapshots.js';
import { getTimeoutMs } from '../../utilities/timeout.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';

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

// listbox（オートコンプリート等）に対して、候補 option を選択するベストエフォート実装
// - originLocator: 入力した textbox/combobox のロケーター
// - queryText: 入力文字列（完全一致 > 部分一致 > 先頭一致 > 最初の候補 の順で選択）
// 返り値: 選択に成功した場合 true（候補が見つからない/出現しない場合は false）
export async function trySelectListboxOption(
  page: Page,
  originLocator: Locator,
  queryText: string,
  attemptTimeoutMs?: number,
): Promise<boolean> {
  const envTimeout = getTimeoutMs('agent');
  const t = Number.isFinite(Number(attemptTimeoutMs)) && Number(attemptTimeoutMs) > 0
    ? Math.trunc(Number(attemptTimeoutMs))
    : Math.min(envTimeout, 2000);

  // 可能なら同一ダイアログ内をスコープにする（候補ポップアップがポータル外の場合の誤検出を抑制）
  let scope: Locator | null = null;
  try {
    const dlg = originLocator.locator('xpath=ancestor-or-self::*[@role="dialog"]').first();
    if ((await dlg.count()) > 0) scope = dlg;
  } catch {}
  const base = scope ?? page;

  // 候補 listbox の出現を短めに待機
  let listbox: Locator | null = null;
  try {
    const lb = base.getByRole('listbox' as any).first();
    await lb.waitFor({ state: 'visible', timeout: t });
    listbox = lb;
  } catch {
    // listbox が見つからない場合は諦める（通常の textbox の可能性）
    return false;
  }

  // option 候補から最適一致を選ぶ
  try {
    const exact = base.getByRole('option' as any, { name: queryText, exact: true } as any).first();
    if ((await exact.count()) > 0) {
      await exact.scrollIntoViewIfNeeded();
      await exact.click({ timeout: t });
      try { await listbox!.waitFor({ state: 'hidden', timeout: t }); } catch {}
      return true;
    }
  } catch {}

  try {
    const partial = base.getByRole('option' as any, { name: new RegExp(queryText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } as any).first();
    if ((await partial.count()) > 0) {
      await partial.scrollIntoViewIfNeeded();
      await partial.click({ timeout: t });
      try { await listbox!.waitFor({ state: 'hidden', timeout: t }); } catch {}
      return true;
    }
  } catch {}

  // いずれも見つからない場合は先頭候補を選択
  try {
    const first = base.getByRole('option' as any).first();
    if ((await first.count()) > 0) {
      await first.scrollIntoViewIfNeeded();
      await first.click({ timeout: t });
      try { await listbox!.waitFor({ state: 'hidden', timeout: t }); } catch {}
      return true;
    }
  } catch {}

  return false;
}

// ref → DOM ロケーター解決（データ属性/索引がなくてもスナップショットの序数と祖先ロールを用いた多段フォールバック）
export async function resolveLocatorByRef(
  page: Page,
  ref: string,
): Promise<Locator | null> {
  const t = getTimeoutMs('agent');

  // 0) data 属性が既に付与されていれば最優先
  try {
    const byAttr = page.locator(`[data-wg-ref="${ref}"]`).first();
    if ((await byAttr.count()) > 0) return byAttr;
  } catch {}

  // 1) ページ内のサイドカー索引（任意実装）
  try {
    const idx = await page.evaluate((r: string) => (window as any).__WG_REF_INDEX__?.[r], ref).catch(() => null as any);
    if (idx?.css) {
      const byCss = page.locator(idx.css).first();
      if ((await byCss.count()) > 0) {
        try { await byCss.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return byCss;
      }
    }
    if (idx?.xpath) {
      const byXpath = page.locator(`xpath=${idx.xpath}`).first();
      if ((await byXpath.count()) > 0) {
        try { await byXpath.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return byXpath;
      }
    }
    if (idx?.role && Number.isFinite(idx.roleIndex)) {
      const loc = page.getByRole(idx.role as any);
      const nth = loc.nth(Math.max(0, Math.trunc(idx.roleIndex)));
      if ((await nth.count()) > 0) {
        try { await nth.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return nth;
      }
    }
  } catch {}

  // 2) スナップショットを用いた序数ベースの推定（祖先ロールも考慮）
  let snapText: string | null = null;
  try { snapText = await getSnapshotForAI(page); } catch {}
  if (!snapText) {
    // role/name が分かれば最終フォールバック
    try {
      const rn = findRoleAndNameByRef('', ref);
      if (rn?.role) {
        const loc = rn.name
          ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
          : page.getByRole(rn.role as any);
        return loc.first();
      }
    } catch {}
    return null;
  }

  // パース: 行単位にして ref を含む行を特定
  const lines = snapText.split(/\r?\n/);
  const refToken = `[ref=${ref}]`;
  let targetIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.includes(refToken)) { targetIdx = i; break; }
  }
  if (targetIdx === -1) return null;

  // 役割抽出（同ファイルの findRoleAndNameByRef を流用）
  const rn = findRoleAndNameByRef(snapText, ref);
  const role = rn?.role || '';
  const name = rn?.name || '';

  // 祖先のロール候補を収集（近い順に最大5件）
  const ancestorRoles: string[] = [];
  for (let j = targetIdx - 1; j >= 0 && ancestorRoles.length < 5; j -= 1) {
    const m = /-\s*([a-zA-Z]+)(?:\s+"[^"]+")?.*\[ref=/.exec(lines[j]!);
    if (m) {
      const r = m[1]!.toLowerCase();
      if (!['generic', 'text', 'separator', 'figure', 'img'].includes(r)) ancestorRoles.push(r);
    }
  }

  // 同ロールの序数（スナップショット内での出現順）を求める
  function computeRoleIndex(targetLineIndex: number, roleName: string): number {
    let count = 0;
    const roleRegex = new RegExp(`-\\s*${roleName}(\\s|\\[|\\")`, 'i');
    for (let i = 0; i <= targetLineIndex; i += 1) {
      if (roleRegex.test(lines[i]!)) count += 1;
    }
    return Math.max(0, count - 1);
  }

  // 祖先ロールの nth を順に試しながらスコープを狭める
  let scope: Locator | null = null;
  try {
    for (const aRole of ancestorRoles) {
      const aIdx = computeRoleIndex(targetIdx, aRole);
      const aLoc = page.getByRole(aRole as any).nth(aIdx);
      const exists = (await aLoc.count()) > 0;
      if (exists) { scope = aLoc; break; }
    }
  } catch {}

  // 最終ロケーター（スコープがあれば内部で、なければページ全体で）
  try {
    if (role) {
      const base = scope ?? page;
      let loc = name
        ? base.getByRole(role as any, { name, exact: true } as any)
        : base.getByRole(role as any);

      // スナップショット序数で nth 指定
      const idx = computeRoleIndex(targetIdx, role);
      loc = loc.nth(idx);
      const exists = (await loc.count()) > 0;
      if (exists) {
        try { await loc.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return loc;
      }
    }
  } catch {}

  // 役割が取れない場合の緩いフォールバック: 祖先スコープがあれば最初の入力要素
  try {
    if (scope) {
      const anyTextbox = scope.getByRole('textbox' as any).first();
      if ((await anyTextbox.count()) > 0) {
        try { await anyTextbox.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return anyTextbox;
      }
    }
  } catch {}

  return null;
}




