import { ensureSharedBrowserStarted, takeSnapshots, formatToolError, clickWithFallback } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import { getSnapshotForAI } from '../../utilities/snapshots.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

export async function browserClick(ref: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const snapText = await getSnapshotForAI(page);
      const rn = findRoleAndNameByRef(snapText, ref);
      if (!rn) throw new Error(`ref=${ref} に対応する要素が見つかりません (指定スナップショット)`);
      const locator = rn.name
        ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
        : page.getByRole(rn.role as any);
      const el = locator.first();
      await el.waitFor({ state: 'visible', timeout: t });
      const isCheckbox = String(rn.role || '').toLowerCase() === 'checkbox';
      await clickWithFallback(page, el, isCheckbox);
      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({ ok: true, action: 'click', ref, target: { role: rn.role, name: rn.name }, snapshots: { text: snaps.text, id: snapshotId } });
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { ok: formatToolError(e), action: 'click', ref };
      if (snaps) {
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        payload.snapshots = { text: snaps.text, id: snapshotId };
      }
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ ok: formatToolError(e), action: 'click', ref });
  }
}


