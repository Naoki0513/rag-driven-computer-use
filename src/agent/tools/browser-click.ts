import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, clickWithFallback, resolveLocatorByRef, attachTodos, getResolutionSnapshotText, rerankSnapshotTopChunks } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type ClickInput = { ref: string; query: string; double?: boolean };

export async function browserClick(input: ClickInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const ref = String((input as any)?.ref ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      const isDouble = ((input as any)?.double === true) || String((input as any)?.double ?? '').toLowerCase() === 'true';

      if (!query) {
        const payload = await attachTodos({ ok: 'Error: query is required', action: 'click', ref });
        return JSON.stringify(payload);
      }
      if (!ref) {
        const payload = await attachTodos({ ok: 'Error: ref is required', action: 'click', ref });
        return JSON.stringify(payload);
      }

      // ref から直接ロケーター解決（aria-ref → data-wg-ref → サイドカー索引 → スナップショット序数ベース）
      const _snapForResolve = getResolutionSnapshotText();
      const el = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);

      if (!el) {
        throw new Error(`Element not found for ref=${ref}`);
      }

      await el.waitFor({ state: 'visible', timeout: t });
      // 役割が不明でも checkbox 判定のために aria-role を読む
      let isCheckbox = false;
      try {
        const roleAttr = await el.getAttribute('role');
        isCheckbox = String(roleAttr || '').toLowerCase() === 'checkbox';
      } catch {}
      const clickErrors: string[] = [];
      if (isDouble) {
        try {
          await el.dblclick({ timeout: t });
        } catch (e: any) {
          clickErrors.push(`[dblclick] ${formatToolError(e)}`);
          try {
            await el.scrollIntoViewIfNeeded();
            await el.dblclick({ timeout: t });
          } catch (e2: any) {
            clickErrors.push(`[scroll+dblclick] ${formatToolError(e2)}`);
            // 最後のフォールバックとして通常クリックに切り替え
            await clickWithFallback(page, el, isCheckbox, undefined, clickErrors);
          }
        }
      } else {
        await clickWithFallback(page, el, isCheckbox, undefined, clickErrors);
      }
      try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'click', ref, mode: isDouble ? 'double' : 'single', diagnostics: (clickErrors.length ? { clickErrors } : undefined), snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const ref = String((input as any)?.ref ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      const isDouble = ((input as any)?.double === true) || String((input as any)?.double ?? '').toLowerCase() === 'true';
      let payload: any = { ok: formatToolError(e), action: 'click', ref, query, mode: isDouble ? 'double' : 'single' };
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
    const payload = await attachTodos({ ok: formatToolError(e), action: 'click', ref });
    return JSON.stringify(payload);
  }
}


