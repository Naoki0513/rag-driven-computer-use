import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';

export async function browserPress(ref: string, key: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const { locator, role, name } = await resolveLocatorByRef(page, ref);
      await locator.first().press(key);
      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({ success: true, action: 'press', ref, key, target: { role, name }, snapshots: { text: snaps.text, id: snapshotId } });
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




