import type { Page } from 'playwright';
import yaml from 'js-yaml';
import type { NodeState } from './types.js';

export async function captureNode(page: Page, cfg: { maxHtmlSize: number }): Promise<NodeState> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  const url = page.url();
  // Keep snapshot size tuning by indirectly limiting underlying content via Playwright if needed
  // Only store minimal fields as requested
  const snapshotForAI = await getSnapshotForAI(page);

  return {
    url,
    snapshotForAI,
    timestamp: new Date().toISOString(),
  };
}

export async function getAccessibilitySnapshot(page: Page): Promise<Record<string, unknown>> {
  const tree = await page.accessibility.snapshot().catch(() => ({}));
  return tree as Record<string, unknown>;
}

export async function getLocatorAriaSnapshot(page: Page): Promise<string> {
  try {
    // Try Locator.ariaSnapshot if available (Playwright >= 1.49)
    const locator: any = (page as any).locator('html');
    if (locator?.ariaSnapshot) {
      const result = await locator.ariaSnapshot();
      if (typeof result === 'string') return result;
      return yaml.dump(result ?? {}, { noRefs: true });
    }
  } catch {}
  // Fallback to accessibility snapshot YAML
  const tree = await getAccessibilitySnapshot(page);
  return yaml.dump(tree, { noRefs: true });
}

type PageWithSnapshotForAI = Page & { _snapshotForAI?: () => Promise<string> };

export async function getSnapshotForAI(page: Page): Promise<string> {
  // Try Playwright MCP private API first
  try {
    const pw = page as PageWithSnapshotForAI;
    if (typeof pw._snapshotForAI === 'function') {
      const text = await pw._snapshotForAI();
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
  } catch {}
  // Fallback: YAML of accessibility snapshot
  const tree = await getAccessibilitySnapshot(page);
  return yaml.dump(tree, { noRefs: true });
}

