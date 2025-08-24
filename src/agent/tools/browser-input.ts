import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';

export async function browserInput(ref: string, text: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  const { locator, role, name } = await resolveLocatorByRef(page, ref);
  await locator.first().fill(text);
  const snaps = await takeSnapshots(page);
  return JSON.stringify({ success: true, action: 'input', ref, text, target: { role, name }, snapshots: { text: snaps.text, hash: snaps.hash } });
}




