import type { Page } from 'playwright';
import type { NodeState } from './types.js';
import { normalizeUrl } from './url.js';
import { computeSha256Hex } from './text.js';

export async function captureNode(page: Page, options: { depth: number }): Promise<NodeState> {
  await page.waitForLoadState('networkidle').catch(() => {});
  try { await page.waitForTimeout(3000); } catch {}

  const rawUrl = page.url();
  const normalizedUrl = normalizeUrl(rawUrl);
  const snapshotForAI = await getSnapshotForAI(page);
  const urlObj = new URL(normalizedUrl);
  const site = `${urlObj.protocol}//${urlObj.host}`;
  const snapshotHash = computeSha256Hex(snapshotForAI);

  return {
    site,
    url: normalizedUrl,
    snapshotForAI,
    snapshotHash,
    timestamp: new Date().toISOString(),
    depth: options.depth,
  };
}

type PageWithSnapshotForAI = Page & { _snapshotForAI?: () => Promise<string> };

export async function getSnapshotForAI(page: Page): Promise<string> {
  const pw = page as PageWithSnapshotForAI;
  if (typeof pw._snapshotForAI !== 'function') throw new Error('_snapshotForAI is not available on this page');
  const text = await pw._snapshotForAI();
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('_snapshotForAI returned empty text');
  return text;
}


