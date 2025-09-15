import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, resolveLocatorByRef, attachTodos, getResolutionSnapshotText } from './util.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

export async function browserInput(ref: string, text: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const _snapForResolve = getResolutionSnapshotText();
      const loc = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
      if (!loc) {
        const snapText = getResolutionSnapshotText();
        const rn = snapText ? findRoleAndNameByRef(snapText, ref) : null;
        if (!rn) throw new Error(`ref=${ref} に対応する要素が見つかりません`);
        const locator = rn.name
          ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
          : page.getByRole(rn.role as any);
        const fallback = locator.first();
        await fallback.waitFor({ state: 'visible', timeout: t });
        await fallback.fill(text);
        const snaps0 = await captureAndStoreSnapshot(page);
        const payload0 = await attachTodos({ ok: true, action: 'input', ref, text, snapshots: { text: snaps0.text } });
        return JSON.stringify(payload0);
      }
      await loc.waitFor({ state: 'visible', timeout: t });
      await loc.fill(text);
      const snaps = await captureAndStoreSnapshot(page);
      const payload = await attachTodos({ ok: true, action: 'input', ref, text, snapshots: { text: snaps.text } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      let payload: any = { ok: formatToolError(e), action: 'input', ref, text };
      if (snaps) {
        payload.snapshots = { text: snaps.text };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'input', ref, text });
    return JSON.stringify(payload);
  }
}




