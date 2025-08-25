import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';

export async function browserPress(ref: string, key: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const { locator, role, name } = await resolveLocatorByRef(page, ref);
      await locator.first().press(key);
      const snaps = await takeSnapshots(page);
      return JSON.stringify({ success: true, action: 'press', ref, key, target: { role, name }, snapshots: { text: snaps.text, hash: snaps.hash } });
    } catch (e: any) {
      let snaps: { text: string; hash: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { success: false, action: 'press', ref, key, error: String(e?.message ?? e) };
      if (snaps) payload.snapshots = { text: snaps.text, hash: snaps.hash };
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, action: 'press', ref, key, error: String(e?.message ?? e) });
  }
}




