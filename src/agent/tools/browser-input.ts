import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';

export async function browserInput(ref: string, text: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const { locator, role, name } = await resolveLocatorByRef(page, ref);
      await locator.first().fill(text);
      const snaps = await takeSnapshots(page);
      return JSON.stringify({ success: true, action: 'input', ref, text, target: { role, name }, snapshots: { text: snaps.text, hash: snaps.hash } });
    } catch (e: any) {
      let snaps: { text: string; hash: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { success: false, action: 'input', ref, text, error: String(e?.message ?? e) };
      if (snaps) payload.snapshots = { text: snaps.text, hash: snaps.hash };
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, action: 'input', ref, text, error: String(e?.message ?? e) });
  }
}




