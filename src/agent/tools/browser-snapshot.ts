import { ensureSharedBrowserStarted, takeSnapshots, formatToolError } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';

export async function browserSnapshot(): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({ ok: true, action: 'snapshot', snapshots: { text: snaps.text, id: snapshotId } });
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { ok: formatToolError(e), action: 'snapshot' };
      if (snaps) {
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        payload.snapshots = { text: snaps.text, id: snapshotId };
      }
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ ok: formatToolError(e), action: 'snapshot' });
  }
}




