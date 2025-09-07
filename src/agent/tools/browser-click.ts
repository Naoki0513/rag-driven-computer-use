import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, clickWithFallback, resolveLocatorByRef, attachTodos, getResolutionSnapshotText } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

export async function browserClick(ref: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      // まずは ref から直接ロケーター解決（data-wg-ref / 索引 / 序数）
      const _snapForResolve = getResolutionSnapshotText();
      const el = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
      if (!el) {
        const snapText = getResolutionSnapshotText();
        const rn = snapText ? findRoleAndNameByRef(snapText, ref) : null;
        if (!rn) throw new Error(`ref=${ref} に対応する要素が見つかりません`);
        const locator = rn.name
          ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
          : page.getByRole(rn.role as any);
        const fallbackEl = locator.first();
        await fallbackEl.waitFor({ state: 'visible', timeout: t });
        const isCheckbox = String(rn.role || '').toLowerCase() === 'checkbox';
        await clickWithFallback(page, fallbackEl, isCheckbox);
        const snaps = await captureAndStoreSnapshot(page);
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        const payload = await attachTodos({ ok: true, action: 'click', ref, target: { role: rn.role, name: rn.name }, snapshots: { text: snaps.text, id: snapshotId } });
        return JSON.stringify(payload);
      }
      await el.waitFor({ state: 'visible', timeout: t });
      // 役割が不明でも checkbox 判定のために aria-role を読む
      let isCheckbox = false;
      try {
        const roleAttr = await el.getAttribute('role');
        isCheckbox = String(roleAttr || '').toLowerCase() === 'checkbox';
      } catch {}
      await clickWithFallback(page, el, isCheckbox);
      const snaps = await captureAndStoreSnapshot(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      const payload = await attachTodos({ ok: true, action: 'click', ref, snapshots: { text: snaps.text, id: snapshotId } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      let payload: any = { ok: formatToolError(e), action: 'click', ref };
      if (snaps) {
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        payload.snapshots = { text: snaps.text, id: snapshotId };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'click', ref });
    return JSON.stringify(payload);
  }
}


