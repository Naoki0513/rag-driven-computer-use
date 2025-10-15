import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos, rerankSnapshotTopChunks, resolveLocatorByRef, getResolutionSnapshotText } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type DialogInput = { action: 'accept' | 'dismiss'; promptText?: string; query: string; triggerRef?: string };

export async function browserHandleDialog(input: DialogInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const action = (String((input as any)?.action ?? '').toLowerCase() === 'accept') ? 'accept' : 'dismiss';
      const promptText = String((input as any)?.promptText ?? '');
      const query = String((input as any)?.query ?? '').trim();
      const triggerRef = String((input as any)?.triggerRef ?? '').trim();

      if (!query) return JSON.stringify(await attachTodos({ ok: 'エラー: query は必須です', action: 'dialog', op: action }));

      const handler = async (dialog: any) => {
        try {
          if (action === 'accept') await dialog.accept(promptText || undefined);
          else await dialog.dismiss();
        } catch {}
      };
      page.on('dialog', handler as any);

      // triggerRef が指定されていれば、その要素をクリックしてダイアログを発火
      if (triggerRef) {
        const snap = getResolutionSnapshotText();
        const loc = await resolveLocatorByRef(page, triggerRef, snap ? { resolutionSnapshotText: snap } : undefined);
        if (!loc) throw new Error(`triggerRef=${triggerRef} に対応する要素が見つかりません`);
        try { await loc.click({ timeout: t }); } catch {}
      }

      // 短い待機でハンドラが実行されるのを猶予
      try { await page.waitForTimeout(150); } catch {}
      page.off('dialog', handler as any);

      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'dialog', op: action, snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const action = (String((input as any)?.action ?? '').toLowerCase() === 'accept') ? 'accept' : 'dismiss';
      const query = String((input as any)?.query ?? '').trim();
      const triggerRef = String((input as any)?.triggerRef ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'dialog', op: action, query, triggerRef };
      if (snaps) {
        let top: Array<{ score: number; text: string }> = [];
        try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
        payload.snapshots = { top: top.map(({ text }) => ({ text })), url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const action = (String((input as any)?.action ?? '').toLowerCase() === 'accept') ? 'accept' : 'dismiss';
    const payload = await attachTodos({ ok: formatToolError(e), action: 'dialog', op: action });
    return JSON.stringify(payload);
  }
}





