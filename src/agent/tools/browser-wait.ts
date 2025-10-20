import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos, rerankSnapshotTopChunks } from './util.js';

type WaitInput = { duration: number; query: string };

export async function browserWait(input: WaitInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const duration = Math.max(0, Math.trunc(Number((input as any)?.duration ?? 0)));
      const query = String((input as any)?.query ?? '').trim();

      if (!query) {
        const payload = await attachTodos({ ok: 'Error: query is required', action: 'wait', duration });
        return JSON.stringify(payload);
      }
      if (!duration || duration <= 0) {
        const payload = await attachTodos({ ok: 'Error: duration must be a positive number (milliseconds)', action: 'wait', duration });
        return JSON.stringify(payload);
      }

      console.log(`[browser_wait] Waiting for ${duration}ms...`);
      await page.waitForTimeout(duration);
      console.log(`[browser_wait] Wait completed`);

      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'wait', duration, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const duration = Math.max(0, Math.trunc(Number((input as any)?.duration ?? 0)));
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'wait', duration, query };
      if (snaps) {
        let top: Array<{ score: number; text: string }> = [];
        try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
        payload.snapshots = { top: top.map(({ text }) => ({ text })), url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const duration = Math.max(0, Math.trunc(Number((input as any)?.duration ?? 0)));
    const payload = await attachTodos({ ok: formatToolError(e), action: 'wait', duration });
    return JSON.stringify(payload);
  }
}

