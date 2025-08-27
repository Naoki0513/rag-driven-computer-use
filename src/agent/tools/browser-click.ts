import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';

export async function browserClick(ref: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const { locator, role, name } = await resolveLocatorByRef(page, ref);
      await locator.first().click();
      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({ success: true, action: 'click', ref, target: { role, name }, snapshots: { text: snaps.text, id: snapshotId } });
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { success: false, action: 'click', ref, error: String(e?.message ?? e) };
      if (snaps) {
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        payload.snapshots = { text: snaps.text, id: snapshotId };
      }
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, action: 'click', ref, error: String(e?.message ?? e) });
  }
}


