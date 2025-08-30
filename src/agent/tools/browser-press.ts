import { ensureSharedBrowserStarted, takeSnapshots } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import { getSnapshotForAI } from '../../utilities/snapshots.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';

export async function browserPress(ref: string, key: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const snapText = await getSnapshotForAI(page);
      const rn = findRoleAndNameByRef(snapText, ref);
      if (!rn) throw new Error(`ref=${ref} に対応する要素が見つかりません (指定スナップショット)`);
      const locator = rn.name
        ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
        : page.getByRole(rn.role as any);
      await locator.first().waitFor({ state: 'visible', timeout: 30000 });
      await locator.first().press(key);
      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({ success: true, action: 'press', ref, key, target: { role: rn.role, name: rn.name }, snapshots: { text: snaps.text, id: snapshotId } });
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { success: false, action: 'press', ref, key, error: String(e?.message ?? e) };
      if (snaps) {
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        payload.snapshots = { text: snaps.text, id: snapshotId };
      }
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, action: 'press', ref, key, error: String(e?.message ?? e) });
  }
}




