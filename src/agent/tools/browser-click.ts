import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';

export async function browserClick(ref: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  const { locator, role, name } = await resolveLocatorByRef(page, ref);
  await locator.first().click();
  const snaps = await takeSnapshots(page);
  return JSON.stringify({ success: true, action: 'click', ref, target: { role, name }, snapshots: { text: snaps.text, hash: snaps.hash } });
}


