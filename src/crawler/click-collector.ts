import type { Page } from 'playwright';
import { getTimeoutMs } from '../utilities/timeout.js';
import { interactionsFromSnapshot } from './interactions.js';
import { isInternalLink, normalizeUrl } from '../utilities/url.js';
import { capture } from './capture.js';
import { ensureAuthenticated } from './session.js';
import { extractInternalUrlsFromSnapshot } from './url-extraction.js';

export function extractClickableElementSigs(snapshotText: string): Set<string> {
  const sigs = new Set<string>();
  try {
    const lines = snapshotText.split(/\r?\n/);
    for (const raw of lines) {
      const line = (raw ?? '').trim();
      if (!line.includes('[cursor=pointer]')) continue;
      const m = /^-\s*([A-Za-z]+)\s*(?:"([^"]+)")?/.exec(line);
      if (!m) continue;
      const role = (m[1] || '').toLowerCase();
      const name = (m[2] || '').trim().toLowerCase();
      if (!role) continue;
      const allowedRoles = ['button', 'link', 'tab', 'menuitem', 'treeitem', 'disclosure'];
      if (!allowedRoles.includes(role)) continue;
      sigs.add(`${role}|${name}`);
    }
  } catch {}
  return sigs;
}

// 親要素のクリック情報を保持する型
type ParentClickInfo = {
  role: string;
  name: string;
};

export async function clickPointerAndCollect(
  page: Page,
  snapshotText: string,
  discovered: Set<string>,
  baseUrlSet: Set<string>,
  baseElemSet: Set<string>,
  baseUrl: string,
  path: string[],
  level: number,
  _firstMutatorSig: string | null = null,
  globalElemSigSet?: Set<string>,
  config?: { targetUrl: string; loginUrl?: string; loginUser?: string; loginPass?: string; storageStatePath?: string; maxUrls?: number; onDiscovered?: (url: string) => Promise<void> | void; shouldStop?: () => boolean },
  parentClick?: ParentClickInfo, // level=0からlevel=1に遷移した際の親要素
  level0RootUrl?: string // level=0のrootURL
): Promise<void> {
  const t = getTimeoutMs('crawler');
  const rootUrl = normalizeUrl(page.url());
  // level=0の場合、このrootUrlを記録
  const actualLevel0RootUrl = level === 0 ? rootUrl : (level0RootUrl || rootUrl);
  const interactions = await interactionsFromSnapshot(snapshotText);
  // クローリング目的：新しいページやコンテンツ領域にアクセスできる要素のみ
  const allowed = new Set([
    'button',     // ボタン（アクション実行、モーダル表示）
    'tab',        // タブ（タブパネル切り替え）
    'menuitem',   // メニュー項目（サブメニュー展開、ページ遷移）
    'link',       // リンク（ページ遷移、ドロップダウンメニュー展開）
    'treeitem',   // ツリー項目（ツリーノード展開）
    'disclosure', // 展開可能要素（アコーディオン、折りたたみセクション展開）
  ]);
  const candidates = interactions.filter((i) => i.ref && i.role && allowed.has((i.role || '').toLowerCase()));
  try { console.info(`[root=${rootUrl}] [level=${level}] [path=${path.join(' > ')}] candidates=${candidates.length}`); } catch {}
  for (let idx = 0; idx < candidates.length; idx += 1) {
    if (config?.shouldStop?.()) {
      try { console.info(`[root=${rootUrl}] [level=${level}] shouldStop=true; stop clicking`); } catch {}
      return;
    }
    const it = candidates[idx]!;
    const roleLower = (it.role || '').toLowerCase();

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
    if (globalElemSigSet) globalElemSigSet.add(sig);

    // ログアウト/ログイン誘導系のボタン/リンクは認証状態に影響するためスキップ
    const authDangerPatterns = /sign\s*out|log\s*out|logout|サインアウト|ログアウト|sign\s*in|log\s*in|login|サインイン|ログイン|forgot\s*your\s*password|パスワードを忘れた/i;
    if (authDangerPatterns.test(labelName)) {
      try { console.info(`[root=${rootUrl}] [level=${level}] skip logout element: ${labelName}`); } catch {}
      continue;
    }

    // hrefの有無に関わらず、すべてのクリック可能要素を実際にクリックする
    // （JavaScriptドロップダウンメニュー等、クリックしないと表示されないコンテンツに対応）

    try {
      const locator = page.getByRole(it.role as any, (it.name ? { name: it.name, exact: true } as any : undefined) as any).first();
      let isVisible = false;
      let isEnabled = false;
      try { isVisible = await locator.isVisible(); } catch {}
      try { isEnabled = await locator.isEnabled(); } catch {}
      try { console.info(`[root=${rootUrl}] [level=${level}] diagnostics visible=${isVisible} enabled=${isEnabled}`); } catch {}
      try { 
        await locator.waitFor({ state: 'visible', timeout: t }); 
      } catch (waitErr) { 
        // 要素が見つからない・表示されない場合もページを復元
        try { 
          console.warn(`[root=${rootUrl}] [level=${level}] element not visible role=${it.role} name="${labelName}" ref=${refStr}`); 
        } catch {}
        try {
          await restorePageState(page, level, rootUrl, actualLevel0RootUrl, parentClick, t);
        } catch (restoreErr) {
          try { console.warn(`[root=${rootUrl}] [level=${level}] failed to restore page after visibility failure: ${String((restoreErr as any)?.message ?? restoreErr)}`); } catch {}
        }
        continue; 
      }

      // 新しいタブ/ページが開かれた場合の監視と自動クローズ（外部リンクの場合）
      const context = page.context();
      const newPagesOpened: Page[] = [];
      const pageCreatedHandler = async (newPage: Page) => {
        newPagesOpened.push(newPage);
        try {
          // 新しいページの読み込みを少し待つ
          await newPage.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => {});
          const newPageUrl = normalizeUrl(newPage.url());
          try { console.info(`[root=${rootUrl}] [level=${level}] new tab opened: ${newPageUrl}`); } catch {}
          
          // 内部リンクでない場合はすぐ閉じる
          if (!isInternalLink(newPageUrl, baseUrl)) {
            try { console.info(`[root=${rootUrl}] [level=${level}] closing external tab: ${newPageUrl}`); } catch {}
            await newPage.close().catch(() => {});
          }
        } catch (err) {
          try { console.warn(`[root=${rootUrl}] [level=${level}] error handling new page: ${String((err as any)?.message ?? err)}`); } catch {}
          // エラーが発生した場合もページを閉じる
          try { await newPage.close(); } catch {}
        }
      };
      context.on('page', pageCreatedHandler);

      const urlWaiter = page
        .waitForFunction((prev) => window.location.href !== prev, rootUrl, { timeout: t })
        .then(() => true)
        .catch(() => false);

      await locator.click({ timeout: t });
      const changed = await urlWaiter;

      // イベントリスナーのクリーンアップとタブ処理
      try {
        context.off('page', pageCreatedHandler);
        // クリック後少し待って、新しいタブが完全に開かれるのを待つ
        await page.waitForTimeout(500);
        
        // 開かれたままの新しいページ（内部リンク）がある場合の処理
        // 内部リンクの場合もタブが開かれたままだとメモリを圧迫するため、
        // 現在のページに戻らない場合でもタブを閉じる
        for (const newPage of newPagesOpened) {
          if (!newPage.isClosed()) {
            const newPageUrl = normalizeUrl(newPage.url());
            // 内部リンクの場合でも、現在のメインページではない新しいタブは閉じる
            if (newPage !== page) {
              try { console.info(`[root=${rootUrl}] [level=${level}] closing opened tab to prevent memory leak: ${newPageUrl}`); } catch {}
              await newPage.close().catch(() => {});
            }
          }
        }
      } catch (cleanupErr) {
        try { console.warn(`[root=${rootUrl}] [level=${level}] error during tab cleanup: ${String((cleanupErr as any)?.message ?? cleanupErr)}`); } catch {}
      }

      if (changed) {
        const newUrl = normalizeUrl(page.url());
        try { console.info(`[root=${rootUrl}] [level=${level}] URL changed -> ${newUrl}`); } catch {}
        if (isInternalLink(newUrl, baseUrl)) discovered.add(newUrl);
        try { await config?.onDiscovered?.(newUrl); } catch {}
        try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
        // 遷移先でログインを要求されたら即時復帰
        try {
          if (config?.loginUser && config?.loginPass && config?.targetUrl) {
            const ensureCfg: { targetUrl: string; loginUser: string; loginPass: string; storageStatePath?: string; loginUrl?: string; returnToUrl?: string } = {
              targetUrl: config.targetUrl,
              loginUser: config.loginUser,
              loginPass: config.loginPass,
              returnToUrl: newUrl,
            };
            if (config.storageStatePath) ensureCfg.storageStatePath = config.storageStatePath;
            if (config.loginUrl) ensureCfg.loginUrl = config.loginUrl;
            await ensureAuthenticated(page, ensureCfg as any);
          }
        } catch {}
      } else {
        try { console.info(`[root=${rootUrl}] [level=${level}] no URL change; capturing snapshot for diff`); } catch {}
      }

      const full = await capture(page, baseUrl);
      const snapUrls = extractInternalUrlsFromSnapshot(full.snapshotForAI, full.url, baseUrl);
      const newUrls = snapUrls.filter((u) => !baseUrlSet.has(u));
      for (const u of newUrls) discovered.add(u);
      try { for (const u of newUrls) await config?.onDiscovered?.(u); } catch {}
      if (config?.shouldStop?.()) {
        try { console.info(`[root=${rootUrl}] [level=${level}] shouldStop=true; stop recursion`); } catch {}
        return;
      }

      const newElemSigs = extractClickableElementSigs(full.snapshotForAI);
      const novelElems = Array.from(newElemSigs).filter((s) => !baseElemSet.has(s));
      try { console.info(`[root=${rootUrl}] [level=${level}] new clickable elements after click: ${novelElems.length}`); for (const s of novelElems) console.info(`NEW-ELEM: ${s}`); } catch {}
      if (globalElemSigSet) for (const s of novelElems) globalElemSigSet.add(s.toLowerCase());

      if (changed) {
        try { console.info(`[root=${rootUrl}] [level=${level}] returning to original via reload -> ${rootUrl}`); } catch {}
        await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: t }).catch(() => {});
        try { await page.waitForTimeout(200); } catch {}
      } else if (novelElems.length > 0) {
        const childBaseElems = new Set<string>([...baseElemSet, ...newElemSigs]);
        const childPath = [...path, `${it.role}:${labelName}`];
        // level=0からlevel=1に遷移する際の親要素情報を渡す
        const childParentClick: ParentClickInfo = {
          role: it.role || 'button',
          name: labelName
        };
        await clickPointerAndCollect(
          page,
          full.snapshotForAI,
          discovered,
          new Set([...baseUrlSet, ...newUrls]),
          childBaseElems,
          baseUrl,
          childPath,
          level + 1,
          null,
          globalElemSigSet,
          config,
          childParentClick, // 親要素情報を渡す
          actualLevel0RootUrl // level=0のrootURLを渡す
        );
        if (level === 0) {
          try { console.info(`[root=${rootUrl}] [level=${level}] reload after level-1 exploration -> ${rootUrl}`); } catch {}
          try { await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: t }); } catch {}
          try { await page.waitForTimeout(200); } catch {}
        }
      }
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      try { console.warn(`[root=${rootUrl}] [level=${level}] click failed role=${it.role} name="${labelName}" ref=${refStr} reason=${msg}`); } catch {}
      
      // エラー時のイベントリスナークリーンアップとタブクローズ
      try {
        const context = page.context();
        const allPages = context.pages();
        // メインページ以外のすべてのタブを閉じる
        for (const p of allPages) {
          if (p !== page && !p.isClosed()) {
            try { 
              const pageUrl = normalizeUrl(p.url());
              console.info(`[root=${rootUrl}] [level=${level}] closing orphaned tab after error: ${pageUrl}`); 
            } catch {}
            await p.close().catch(() => {});
          }
        }
      } catch (tabCleanupErr) {
        try { console.warn(`[root=${rootUrl}] [level=${level}] error during tab cleanup after click failure: ${String((tabCleanupErr as any)?.message ?? tabCleanupErr)}`); } catch {}
      }
      
      // クリック失敗後の復元処理
      try {
        await restorePageState(page, level, rootUrl, actualLevel0RootUrl, parentClick, t);
      } catch (restoreErr) {
        try { console.warn(`[root=${rootUrl}] [level=${level}] failed to restore page: ${String((restoreErr as any)?.message ?? restoreErr)}`); } catch {}
      }
    }
  }
}

// ページ状態を復元する関数
async function restorePageState(
  page: Page,
  level: number,
  rootUrl: string,
  level0RootUrl: string,
  parentClick: ParentClickInfo | undefined,
  timeout: number
): Promise<void> {
  const currentUrl = normalizeUrl(page.url());
  
  if (level === 0) {
    // level=0の場合：単純に rootUrl に戻る
    if (currentUrl !== rootUrl) {
      try { console.info(`[level=${level}] restoring to rootUrl: ${currentUrl} -> ${rootUrl}`); } catch {}
      await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
      await page.waitForTimeout(200);
    }
  } else if (level === 1 && parentClick) {
    // level=1の場合：level=0のrootURLに戻り、親要素をクリックして状態を再現
    try { console.info(`[level=${level}] restoring via level-0 root: ${currentUrl} -> ${level0RootUrl} -> click parent(${parentClick.role}:"${parentClick.name}")`); } catch {}
    
    // level=0のrootURLに戻る
    await page.goto(level0RootUrl, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    await page.waitForTimeout(300);
    
    // 親要素をクリックしてlevel=1の状態を再現
    try {
      const locator = page.getByRole(parentClick.role as any, parentClick.name ? { name: parentClick.name, exact: true } as any : undefined).first();
      await locator.waitFor({ state: 'visible', timeout }).catch(() => {});
      await locator.click({ timeout }).catch(() => {});
      await page.waitForTimeout(300);
      try { console.info(`[level=${level}] page state restored to level=1`); } catch {}
    } catch (replayErr) {
      try { console.warn(`[level=${level}] failed to replay parent click: ${String((replayErr as any)?.message ?? replayErr)}`); } catch {}
    }
  }
}


