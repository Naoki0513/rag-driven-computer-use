import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, resolveLocatorByRef, attachTodos, getResolutionSnapshotText, rerankSnapshotTopChunks } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type DragDropInput = { sourceRef: string; targetRef: string; query: string };

export async function browserDragAndDrop(input: DragDropInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const sourceRef = String((input as any)?.sourceRef ?? '').trim();
      const targetRef = String((input as any)?.targetRef ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();

      if (!query) return JSON.stringify(await attachTodos({ ok: 'Error: query is required', action: 'dragdrop', sourceRef, targetRef }));
      if (!sourceRef || !targetRef) return JSON.stringify(await attachTodos({ ok: 'Error: sourceRef and targetRef are required', action: 'dragdrop', sourceRef, targetRef }));

      const snap = getResolutionSnapshotText();
      const src = await resolveLocatorByRef(page, sourceRef, snap ? { resolutionSnapshotText: snap } : undefined);
      const dst = await resolveLocatorByRef(page, targetRef, snap ? { resolutionSnapshotText: snap } : undefined);
      if (!src) throw new Error(`Element not found for sourceRef=${sourceRef}`);
      if (!dst) throw new Error(`Element not found for targetRef=${targetRef}`);

      await src.waitFor({ state: 'visible', timeout: t });
      await dst.waitFor({ state: 'visible', timeout: t });
      await src.dragTo(dst, { timeout: t });

      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'dragdrop', sourceRef, targetRef, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const sourceRef = String((input as any)?.sourceRef ?? '').trim();
      const targetRef = String((input as any)?.targetRef ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'dragdrop', sourceRef, targetRef, query };
      if (snaps) {
        let top: Array<{ score: number; text: string }> = [];
        try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
        payload.snapshots = { top: top.map(({ text }) => ({ text })), url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const sourceRef = String((input as any)?.sourceRef ?? '').trim();
    const targetRef = String((input as any)?.targetRef ?? '').trim();
    const payload = await attachTodos({ ok: formatToolError(e), action: 'dragdrop', sourceRef, targetRef });
    return JSON.stringify(payload);
  }
}






