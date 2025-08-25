import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';

export async function browserClick(ref: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const { locator, role, name } = await resolveLocatorByRef(page, ref);
      await locator.first().click();
      const snaps = await takeSnapshots(page);
      return JSON.stringify({ success: true, action: 'click', ref, target: { role, name }, snapshots: { text: snaps.text, hash: snaps.hash } });
    } catch (e: any) {
      let snaps: { text: string; hash: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { success: false, action: 'click', ref, error: String(e?.message ?? e) };
      if (snaps) payload.snapshots = { text: snaps.text, hash: snaps.hash };
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, action: 'click', ref, error: String(e?.message ?? e) });
  }
}


