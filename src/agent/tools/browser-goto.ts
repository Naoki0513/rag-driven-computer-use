import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos } from './util.js';
import { queryAll } from '../duckdb.js';
import { browserLogin } from './browser-login.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

let _browserGotoHasRun = false;

export async function browserGoto(urlOrId: string, opts?: { autoLogin?: boolean; isId?: boolean }): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  const t = getTimeoutMs('agent');
  const performed: Array<{ stage: string; ok: boolean | string; note?: string }> = [];
  try {
    let navigateUrl = String(urlOrId || '').trim();
    let resolvedById = false;
    // ID指定のサポート（opts?.isId が true の場合、または URL形式でない場合の緩い推定は行わず明示のみ）
    if (opts && opts.isId) {
      const id = navigateUrl;
      const rows = await queryAll<{ url?: string }>(`SELECT "URL" AS url FROM pages WHERE CAST(id AS VARCHAR) = ? LIMIT 1`, [id]);
      const rec = rows[0];
      const u = String((rec as any)?.url ?? '').trim();
      if (!u) {
        const payload = await attachTodos({ action: 'goto', id, performed: [{ stage: 'resolve-id', ok: 'エラー: ID に対応する URL が見つかりません' }] });
        return JSON.stringify(payload);
      }
      navigateUrl = u;
      resolvedById = true;
      performed.push({ stage: 'resolve-id', ok: true, note: `id→url 解決: ${id}` });
    }
    if (!navigateUrl) {
      const payload = await attachTodos({ action: 'goto', url: navigateUrl, performed: [{ stage: 'init', ok: 'エラー: url が空です' }] });
      return JSON.stringify(payload);
    }

    // 1) ページ遷移
    await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: t });
    performed.push({ stage: 'navigate', ok: true });

    // 2) 初回のみ、もしくはオプション指定で自動ログイン
    let shouldAutoLogin = typeof (opts?.autoLogin) === 'boolean' ? !!opts?.autoLogin : !_browserGotoHasRun;
    let loginTried = false;
    if (shouldAutoLogin) {
      try {
        // 軽いヒューリスティック（ユーザー名/パスワード欄が存在しそうなら実施）。
        // ログイン不要な場合でも browserLogin('') は安全に失敗しうるため、例外は握り潰して続行。
        loginTried = true;
        const result = await browserLogin(''); // 現在のページでログイン試行
        // 結果を軽く解析
        try {
          const obj = JSON.parse(result);
          const ok = (obj && typeof obj === 'object' && 'ok' in obj) ? obj.ok : undefined;
          if (ok === true) {
            performed.push({ stage: 'autologin', ok: true });
          } else if (typeof ok === 'string') {
            performed.push({ stage: 'autologin', ok: ok });
          } else {
            performed.push({ stage: 'autologin', ok: true });
          }
        } catch {
          performed.push({ stage: 'autologin', ok: true });
        }
      } catch (e: any) {
        performed.push({ stage: 'autologin', ok: formatToolError(e) });
      }
    } else {
      performed.push({ stage: 'autologin:skip', ok: true, note: '条件によりスキップ' });
    }

    _browserGotoHasRun = true;

    // 3) スナップショット（ログイン実施後の画面）
    try { await page.waitForLoadState('networkidle', { timeout: t }); } catch {}
    const snaps = await captureAndStoreSnapshot(page);
    const payload = await attachTodos({ action: 'goto', url: navigateUrl, performed, snapshots: { text: snaps.text }, meta: { autoLoginRequested: shouldAutoLogin, loginTried, resolvedById } });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ action: 'goto', url: urlOrId, performed: performed.concat([{ stage: 'fatal', ok: formatToolError(e) }]) });
    return JSON.stringify(payload);
  }
}




