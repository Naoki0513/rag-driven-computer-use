import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, resolveLocatorByRef, attachTodos, getResolutionSnapshotText, rerankSnapshotTopChunks } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type PressInput = { ref: string; key: string; query: string };

export async function browserPress(input: PressInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const ref = String((input as any)?.ref ?? '').trim();
      const key = String((input as any)?.key ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();

      if (!query) {
        const payload = await attachTodos({ ok: 'Error: query is required', action: 'press', ref, key });
        return JSON.stringify(payload);
      }
      if (!key) {
        const payload = await attachTodos({ ok: 'Error: key is required', action: 'press', ref });
        return JSON.stringify(payload);
      }
      if (!ref) {
        const payload = await attachTodos({ ok: 'Error: ref is required', action: 'press', ref, key });
        return JSON.stringify(payload);
      }

      // ref から直接ロケーター解決（aria-ref → data-wg-ref → サイドカー索引 → スナップショット序数ベース）
      const _snapForResolve = getResolutionSnapshotText();
      const loc = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);

      if (!loc) {
        throw new Error(`Element not found for ref=${ref}`);
      }

      await loc.waitFor({ state: 'visible', timeout: t });
      await loc.press(key);
      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'press', ref, key, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const ref = String((input as any)?.ref ?? '').trim();
      const key = String((input as any)?.key ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'press', ref, key, query };
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
    const key = String((input as any)?.key ?? '').trim();
    const payload = await attachTodos({ ok: formatToolError(e), action: 'press', ref, key });
    return JSON.stringify(payload);
  }
}




