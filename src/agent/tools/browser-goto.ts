import { ensureSharedBrowserStarted, takeSnapshots } from './util.js';

export async function browserGoto(url: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  const snaps = await takeSnapshots(page);
  return JSON.stringify({ success: true, action: 'goto', url, snapshots: { text: snaps.text, hash: snaps.hash } });
}




