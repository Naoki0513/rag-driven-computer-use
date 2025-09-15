import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

export async function browserGoto(url: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  const t = getTimeoutMs('agent');
  try {
    const navigateUrl = String(url || '').trim();
    if (!navigateUrl) {
      const payload = await attachTodos({ action: 'goto', url: navigateUrl, performed: [{ stage: 'init', ok: 'エラー: url が空です' }] });
      return JSON.stringify(payload);
    }
    await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: t });
    const snaps = await captureAndStoreSnapshot(page);
    const payload = await attachTodos({ action: 'goto', url: navigateUrl, performed: [{ stage: 'navigate', ok: true }], snapshots: { text: snaps.text } });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ action: 'goto', url, performed: [{ stage: 'fatal', ok: formatToolError(e) }] });
    return JSON.stringify(payload);
  }
}




