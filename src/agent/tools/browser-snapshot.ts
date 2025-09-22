import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos } from './util.js';

export async function browserSnapshot(): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const snaps = await captureAndStoreSnapshot(page);
      const payload = await attachTodos({ ok: true, action: 'snapshot', snapshots: { text: snaps.text, url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      let payload: any = { ok: formatToolError(e), action: 'snapshot' };
      if (snaps) {
        payload.snapshots = { text: snaps.text, url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'snapshot' });
    return JSON.stringify(payload);
  }
}




