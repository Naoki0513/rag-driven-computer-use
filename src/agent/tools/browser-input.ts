import { ensureSharedBrowserStarted, takeSnapshots, formatToolError, resolveLocatorByRef, attachTodos } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import { getSnapshotForAI } from '../../utilities/snapshots.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

export async function browserInput(ref: string, text: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const loc = await resolveLocatorByRef(page, ref);
      if (!loc) {
        const snapText = await getSnapshotForAI(page);
        const rn = findRoleAndNameByRef(snapText, ref);
        if (!rn) throw new Error(`ref=${ref} に対応する要素が見つかりません (指定スナップショット)`);
        const locator = rn.name
          ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
          : page.getByRole(rn.role as any);
        const fallback = locator.first();
        await fallback.waitFor({ state: 'visible', timeout: t });
        await fallback.fill(text);
        const snaps0 = await takeSnapshots(page);
        const snapshotId0 = await findPageIdByHashOrUrl(snaps0.hash, snaps0.url);
        const payload0 = await attachTodos({ ok: true, action: 'input', ref, text, snapshots: { text: snaps0.text, id: snapshotId0 } });
        return JSON.stringify(payload0);
      }
      await loc.waitFor({ state: 'visible', timeout: t });
      await loc.fill(text);
      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      const payload = await attachTodos({ ok: true, action: 'input', ref, text, snapshots: { text: snaps.text, id: snapshotId } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      let payload: any = { ok: formatToolError(e), action: 'input', ref, text };
      if (snaps) {
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        payload.snapshots = { text: snaps.text, id: snapshotId };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'input', ref, text });
    return JSON.stringify(payload);
  }
}




