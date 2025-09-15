import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos } from './util.js';
import { findPageIdByHashOrUrl } from '../neo4j.js';

export async function browserSnapshot(): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const snaps = await captureAndStoreSnapshot(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      const payload = await attachTodos({ ok: true, action: 'snapshot', snapshots: { text: snaps.text, id: snapshotId } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      let payload: any = { ok: formatToolError(e), action: 'snapshot' };
      if (snaps) {
        const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
        payload.snapshots = { text: snaps.text, id: snapshotId };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'snapshot' });
    return JSON.stringify(payload);
  }
}




