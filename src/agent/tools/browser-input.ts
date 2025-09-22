import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, resolveLocatorByRef, attachTodos, getResolutionSnapshotText, rerankSnapshotTopChunks } from './util.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type InputInput = { ref?: string; role?: string; name?: string; text: string; query: string };

export async function browserInput(input: InputInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const ref = String((input as any)?.ref ?? '').trim();
      const role = String((input as any)?.role ?? '').trim();
      const name = String((input as any)?.name ?? '').trim();
      const text = String((input as any)?.text ?? '');
      const query = String((input as any)?.query ?? '').trim();

      if (!query) {
        const payload = await attachTodos({ ok: 'エラー: query は必須です', action: 'input', ref, text, target: { role, name } });
        return JSON.stringify(payload);
      }
      if (!ref && !(role && name)) {
        const payload = await attachTodos({ ok: 'エラー: ref または role+name の指定が必要です', action: 'input', ref, text, target: { role, name } });
        return JSON.stringify(payload);
      }

      let loc: any = null;
      if (ref) {
        const _snapForResolve = getResolutionSnapshotText();
        loc = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
      }
      if (!loc && role && name) {
        try {
          const l = page.getByRole(role as any, { name, exact: true } as any).first();
          if ((await l.count()) > 0) loc = l;
        } catch {}
      }
      if (!loc && ref) {
        const snapText = getResolutionSnapshotText();
        const rn = snapText ? findRoleAndNameByRef(snapText, ref) : null;
        if (rn) {
          const l = rn.name
            ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
            : page.getByRole(rn.role as any);
          const candidate = l.first();
          if ((await candidate.count()) > 0) loc = candidate;
        }
      }
      if (!loc) {
        const details = ref ? `ref=${ref}` : `role=${role} name=${name}`;
        throw new Error(`${details} に対応する要素が見つかりません`);
      }

      await loc.waitFor({ state: 'visible', timeout: t });
      await loc.fill(text);
      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query, 3) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'input', ref, text, target: (role||name)?{ role, name }:undefined, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const ref = String((input as any)?.ref ?? '').trim();
      const role = String((input as any)?.role ?? '').trim();
      const name = String((input as any)?.name ?? '').trim();
      const text = String((input as any)?.text ?? '');
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'input', ref, text, target: (role||name)?{ role, name }:undefined, query };
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
    const text = String((input as any)?.text ?? '');
    const payload = await attachTodos({ ok: formatToolError(e), action: 'input', ref, text, target: (role||name)?{ role, name }:undefined });
    return JSON.stringify(payload);
  }
}




