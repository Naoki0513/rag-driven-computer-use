import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos, rerankSnapshotTopChunks } from './util.js';
import { queryAll } from '../duckdb.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

export async function browserGoto(urlOrId: string, opts?: { isId?: boolean; query?: string }): Promise<string> {
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
        const payload = await attachTodos({ action: 'goto', id, performed: [{ stage: 'resolve-id', ok: 'Error: URL not found for ID' }] });
        return JSON.stringify(payload);
      }
      navigateUrl = u;
      resolvedById = true;
      performed.push({ stage: 'resolve-id', ok: true, note: `id→url resolved: ${id}` });
    }
    if (!navigateUrl) {
      const payload = await attachTodos({ action: 'goto', url: navigateUrl, performed: [{ stage: 'init', ok: 'Error: url is empty' }] });
      return JSON.stringify(payload);
    }

    // 1) ページ遷移
    await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: t });
    performed.push({ stage: 'navigate', ok: true });

    // 2) 認証は共有ブラウザ起動時の state.json or 事前ログインのみ（本ツールでは未実施）

    // 3) スナップショット（ログイン実施後の画面）
    // networkidle は重いため削除（domcontentloaded で十分）
    const snaps = await captureAndStoreSnapshot(page);
    let top: Array<{ score: number; text: string }> = [];
    try { top = opts?.query ? await rerankSnapshotTopChunks(snaps.text, String(opts.query)) : []; } catch {}
    const payload = await attachTodos({ action: 'goto', url: navigateUrl, performed, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url }, meta: { resolvedById } });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ action: 'goto', url: urlOrId, performed: performed.concat([{ stage: 'fatal', ok: formatToolError(e) }]) });
    return JSON.stringify(payload);
  }
}




