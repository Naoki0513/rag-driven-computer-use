import type { Page } from 'playwright';
import yaml from 'js-yaml';
import type { NodeState } from './types.js';
import { normalizeUrl } from './url.js';
import { computeSha256Hex } from './text.js';

export async function captureNode(page: Page, options: { depth: number }): Promise<NodeState> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

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

export async function getAccessibilitySnapshot(page: Page): Promise<Record<string, unknown>> {
  const tree = await page.accessibility.snapshot().catch(() => ({}));
  return tree as Record<string, unknown>;
}

type PageWithSnapshotForAI = Page & { _snapshotForAI?: () => Promise<string> };

export async function getSnapshotForAI(page: Page): Promise<string> {
  try {
    const pw = page as PageWithSnapshotForAI;
    if (typeof pw._snapshotForAI === 'function') {
      const text = await pw._snapshotForAI();
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
  } catch {}
  const tree = await getAccessibilitySnapshot(page);
  return yaml.dump(tree, { noRefs: true });
}


