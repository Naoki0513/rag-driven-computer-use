import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, resolveLocatorByRef, attachTodos, getResolutionSnapshotText, rerankSnapshotTopChunks } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type HoverInput = { ref: string; query: string };

export async function browserHover(input: HoverInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const ref = String((input as any)?.ref ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();

      if (!query) {
        const payload = await attachTodos({ ok: 'Error: query is required', action: 'hover', ref });
        return JSON.stringify(payload);
      }
      if (!ref) {
        const payload = await attachTodos({ ok: 'Error: ref is required', action: 'hover', ref });
        return JSON.stringify(payload);
      }

      const _snapForResolve = getResolutionSnapshotText();
      const loc = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
      if (!loc) throw new Error(`Element not found for ref=${ref}`);

      await loc.waitFor({ state: 'visible', timeout: t });
      await loc.hover({ timeout: t });

      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'hover', ref, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const ref = String((input as any)?.ref ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'hover', ref, query };
      if (snaps) {
        let top: Array<{ score: number; text: string }> = [];
        try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
        payload.snapshots = { top: top.map(({ text }) => ({ text })), url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const ref = String((input as any)?.ref ?? '').trim();
    const payload = await attachTodos({ ok: formatToolError(e), action: 'hover', ref });
    return JSON.stringify(payload);
  }
}






