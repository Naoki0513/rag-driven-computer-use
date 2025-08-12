import type { Page } from 'playwright';
import yaml from 'js-yaml';
import type { NodeState } from './types.js';
import { parseSiteAndRoute } from './url.js';
import { computeSha256Hex } from './text.js';

export async function captureNode(page: Page): Promise<NodeState> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  const url = page.url();
  const snapshotForAI = await getSnapshotForAI(page);
  const { site, route } = parseSiteAndRoute(url);
  const snapshotHash = computeSha256Hex(snapshotForAI);

  return { site, route, snapshotForAI, snapshotHash, timestamp: new Date().toISOString() };
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


