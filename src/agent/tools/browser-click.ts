import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, clickWithFallback, resolveLocatorByRef, attachTodos, getResolutionSnapshotText, rerankSnapshotTopChunks } from './util.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type ClickInput = { ref?: string; role?: string; name?: string; query: string };

export async function browserClick(input: ClickInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const ref = String((input as any)?.ref ?? '').trim();
      const role = String((input as any)?.role ?? '').trim();
      const name = String((input as any)?.name ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();

      if (!query) {
        const payload = await attachTodos({ ok: 'エラー: query は必須です', action: 'click', ref, target: { role, name } });
        return JSON.stringify(payload);
      }
      if (!ref && !(role && name)) {
        const payload = await attachTodos({ ok: 'エラー: ref または role+name の指定が必要です', action: 'click', ref, target: { role, name } });
        return JSON.stringify(payload);
      }

      // まずは ref から直接ロケーター解決（data-wg-ref / 索引 / 序数）
      let el: any = null;
      if (ref) {
        const _snapForResolve = getResolutionSnapshotText();
        el = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
      }

      // ref で見つからない場合は role+name で直接解決
      if (!el && role && name) {
        try {
          const locator = page.getByRole(role as any, { name, exact: true } as any);
          const candidate = locator.first();
          if ((await candidate.count()) > 0) el = candidate;
        } catch {}
      }

      // それでもない場合は、スナップショットから ref の role/name を推定
      if (!el && ref) {
        const snapText = getResolutionSnapshotText();
        const rn = snapText ? findRoleAndNameByRef(snapText, ref) : null;
        if (rn) {
          const locator = rn.name
            ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
            : page.getByRole(rn.role as any);
          const candidate = locator.first();
          if ((await candidate.count()) > 0) el = candidate;
        }
      }

      if (!el) {
        const details = ref ? `ref=${ref}` : `role=${role} name=${name}`;
        throw new Error(`${details} に対応する要素が見つかりません`);
      }

      await el.waitFor({ state: 'visible', timeout: t });
      // 役割が不明でも checkbox 判定のために aria-role を読む
      let isCheckbox = false;
      try {
        const roleAttr = await el.getAttribute('role');
        isCheckbox = String(roleAttr || '').toLowerCase() === 'checkbox';
      } catch {}
      const clickErrors: string[] = [];
      await clickWithFallback(page, el, isCheckbox, undefined, clickErrors);
      try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query, 3) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'click', ref, target: (role||name)?{ role, name }:undefined, diagnostics: (clickErrors.length ? { clickErrors } : undefined), snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const ref = String((input as any)?.ref ?? '').trim();
      const role = String((input as any)?.role ?? '').trim();
      const name = String((input as any)?.name ?? '').trim();
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'click', ref, target: (role||name)?{ role, name }:undefined, query };
      if (snaps) {
        let top: Array<{ score: number; text: string }> = [];
        try { top = query ? await rerankSnapshotTopChunks(snaps.text, query, 3) : []; } catch {}
        payload.snapshots = { top: top.map(({ text }) => ({ text })), url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const ref = String((input as any)?.ref ?? '').trim();
    const role = String((input as any)?.role ?? '').trim();
    const name = String((input as any)?.name ?? '').trim();
    const payload = await attachTodos({ ok: formatToolError(e), action: 'click', ref, target: (role||name)?{ role, name }:undefined });
    return JSON.stringify(payload);
  }
}


