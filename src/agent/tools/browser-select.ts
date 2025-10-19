import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, resolveLocatorByRef, attachTodos, getResolutionSnapshotText, rerankSnapshotTopChunks } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type SelectInput = { ref: string; values?: string[]; labels?: string[]; query: string };

export async function browserSelect(input: SelectInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const ref = String((input as any)?.ref ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      const values = Array.isArray((input as any)?.values) ? (input as any).values.map((s: any) => String(s ?? '')) : [];
      const labels = Array.isArray((input as any)?.labels) ? (input as any).labels.map((s: any) => String(s ?? '')) : [];

      if (!query) return JSON.stringify(await attachTodos({ ok: 'Error: query is required', action: 'select', ref }));
      if (!ref) return JSON.stringify(await attachTodos({ ok: 'Error: ref is required', action: 'select', ref }));
      if (!values.length && !labels.length) return JSON.stringify(await attachTodos({ ok: 'Error: values or labels is required', action: 'select', ref }));

      const _snapForResolve = getResolutionSnapshotText();
      const loc = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
      if (!loc) throw new Error(`Element not found for ref=${ref}`);

      await loc.waitFor({ state: 'visible', timeout: t });
      if (values.length) {
        await loc.selectOption(values);
      } else if (labels.length) {
        await loc.selectOption(labels.map((label: string) => ({ label })));
      }

      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'select', ref, values: values.length ? values : undefined, labels: labels.length ? labels : undefined, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const ref = String((input as any)?.ref ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'select', ref, query };
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
    const payload = await attachTodos({ ok: formatToolError(e), action: 'select', ref });
    return JSON.stringify(payload);
  }
}






