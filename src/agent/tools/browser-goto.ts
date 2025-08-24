import { ensureSharedBrowserStarted, takeSnapshots } from './util.js';

export async function browserGoto(url: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  try {
    await page.goto(url);
    await page.waitForLoadState('networkidle').catch(() => {});
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: true, action: 'goto', url, snapshots: { text: snaps.text, hash: snaps.hash } });
  } catch (e: any) {
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: false, action: 'goto', url, error: String(e?.message ?? e), snapshots: { text: snaps.text, hash: snaps.hash } });
  }
}




