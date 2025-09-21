import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos, rerankSnapshotTopChunks } from './util.js';

export async function browserSnapshot(query?: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query, 3) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'snapshot', snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      let payload: any = { ok: formatToolError(e), action: 'snapshot' };
      if (snaps) {
        let top: Array<{ score: number; text: string }> = [];
        try { top = query ? await rerankSnapshotTopChunks(snaps.text, query, 3) : []; } catch {}
        payload.snapshots = { top: top.map(({ text }) => ({ text })), url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'snapshot' });
    return JSON.stringify(payload);
  }
}




