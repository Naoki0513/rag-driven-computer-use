import yaml from 'js-yaml';
import type { Interaction, NodeState } from './types.js';
import { isInternalLink, normalizeUrl, extractRefIdFromSnapshot } from './utils.js';
import type { BrowserContext, Page } from 'playwright';
// Removed getSnapshotForAI import since clickByRef-based re-resolution is no longer used

// Helper: build a flexible name matching regex (ignores case, tolerates spaces/underscores/hyphens)
function buildFlexibleNameRegex(name: string | null | undefined): RegExp | null {
  if (!name) return null;
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped
    .replace(/[_\s]+/g, '\\s*')
    .replace(/-+/g, '[-\\s_]*');
  return new RegExp(flexible, 'i');
}

// Helper: smarter readiness wait than fixed timeout
async function waitForAppReady(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 as any });
    return;
  } catch {}
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 as any });
  } catch {}
  await page.waitForTimeout(1000);
}

// Helper: unify snapshot capture (lazy dynamic import)
async function capture(page: Page): Promise<NodeState> {
  const { captureNode } = await import('./snapshots.js');
  return captureNode(page);
}

export async function interactionsFromSnapshot(snapshotText: string): Promise<Interaction[]> {
  let tree: any = {};
  try {
    // Accept both YAML and JSON-like text; try YAML first as _snapshotForAI can be textual
    tree = yaml.load(snapshotText) as any;
  } catch {
    tree = {};
  }
  const seenKey = new Set<string>();
  const interactions: Interaction[] = [];

  const traverse = (node: any) => {
    const role = String(node?.role ?? '').toLowerCase();
    if (['button', 'link', 'tab', 'menuitem'].includes(role)) {
      const name = String(node?.name ?? 'unnamed');
      const key = `${role}::${name}`;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        const ref: string | null = typeof node?.ref === 'string' ? node.ref : extractRefIdFromSnapshot(yaml.dump(node, { noRefs: true }));
        // href が存在しないが url が入っているスナップショットにも対応
        const href: string | null = typeof node?.href === 'string' ? node.href : (typeof node?.url === 'string' ? node.url : null);
        interactions.push({
          actionType: 'click',
          role,
          name,
          ref,
          href,
        });
      }
    }
    for (const child of node?.children ?? []) traverse(child);
  };
  const isTreeLike = tree && (typeof tree === 'object') && ('role' in tree || 'children' in tree);
  if (isTreeLike)
    traverse(tree);
  else
    extractFromText(snapshotText, interactions, seenKey);
  try {
    console.info(`[interactionsFromSnapshot] extracted ${interactions.length} interactions (unique by role+name).`);
  } catch {}
  return interactions;
}

function extractFromText(snapshotText: string, interactions: Interaction[], seenKey: Set<string>) {
  const roles = ['button', 'link', 'tab', 'menuitem'];
  const lines = snapshotText.split(/\r?\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const role of roles) {
      if (!lower.includes(role)) continue;
      // Try to find a reasonable name near the role
      const nameMatch =
        /name\s*[:=]\s*"([^"]+)"/.exec(line) ||
        /name\s*[:=]\s*'([^']+)'/.exec(line) ||
        new RegExp(role + "[^\"]*\"([^\"]+)\"").exec(line);
      const name = nameMatch?.[1] ?? 'unnamed';
      const key = `${role}::${name}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      const ref = extractRefIdFromSnapshot(line);
      const hrefMatch = /href\s*[:=]\s*['"]([^'"\s]+)['"]/i.exec(line);
      const href = hrefMatch?.[1] ?? null;
      interactions.push({
        actionType: 'click',
        role,
        name,
        ref,
        href,
      });
    }
  }
}

export async function processInteraction(
  context: BrowserContext,
  fromNode: NodeState,
  interaction: Interaction,
  config: { parallelTasks: number; targetUrl: string; visitedUrls?: Set<string>; triedActions?: Set<string> }
): Promise<NodeState | null> {
  if (!context || (typeof (context as any).isClosed === 'function' && (context as any).isClosed())) return null;
  let newPage: Page | null = null;
  try {
    newPage = await context.newPage();
  } catch {
    return null;
  }
  try {
    // Normalize optional sets so we can add without guards
    if (!config.triedActions) config.triedActions = new Set<string>();
    if (!config.visitedUrls) config.visitedUrls = new Set<string>();

    const debugId = `${interaction.role ?? 'unknown-role'}::${interaction.name ?? 'unnamed'}::${interaction.ref ?? interaction.refId ?? 'no-ref'}`;
    console.info(`[processInteraction] start for ${debugId} at ${fromNode.url}`);
    await newPage.goto(fromNode.url, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(newPage);

    const ref = interaction.ref ?? interaction.refId ?? null;
    const href = interaction.href ?? null;
    const currentUrl = fromNode.url;

    // 1) href が内部かつ未訪問なら goto を優先
    if (href) {
      const targetUrl = normalizeUrl(new URL(href, currentUrl).toString());
      if (isInternalLink(targetUrl, config.targetUrl)) {
        if (!config.visitedUrls.has(targetUrl)) {
          const actionKey = `nav:href:${targetUrl}`;
          if (!config.triedActions.has(actionKey)) {
            config.triedActions.add(actionKey);
            console.info(`[processInteraction] try href navigation -> ${targetUrl} (key=${actionKey})`);
            await newPage.goto(targetUrl, { waitUntil: 'networkidle' });
            const newNode = await capture(newPage);
            console.info(`[processInteraction] href navigation succeeded -> ${newNode.url}`);
            return newNode;
          } else {
            console.info(`[processInteraction] skip href navigation (already tried) key=${actionKey}`);
            return null;
          }
        } else {
          console.info(`[processInteraction] skip href navigation (already visited) -> ${targetUrl}`);
          return null;
        }
      }
      // 外部なら href は使わず click にフォールバック
      console.info(`[processInteraction] href is external, fallback to click. href=${href}`);
    }

    // 2) getByRole でクリック（名前マッチを緩和し、候補ロールでフォールバック）
    {
      const roles = Array.from(new Set([interaction.role ?? 'link', 'link', 'button', 'tab', 'menuitem']));
      const triedRoles = new Set<string>();

      const nameRegex = buildFlexibleNameRegex(interaction.name);
      const clickKeyBase = `name:${interaction.name ?? ''}:url:${currentUrl}`;

      for (const role of roles) {
        if (triedRoles.has(role)) continue;
        triedRoles.add(role);
        const options: Parameters<Page['getByRole']>[1] = {} as any;
        if (nameRegex) (options as any).name = nameRegex;
        const locator = newPage.getByRole(role as any, options as any);

        const clickKey = `click:role:${role}:${clickKeyBase}`;
        if (config.triedActions.has(clickKey)) {
          console.info(`[processInteraction] skip getByRole click (already tried) key=${clickKey}`);
          continue;
        }
        console.info(`[processInteraction] fallback getByRole role=${role} name=${interaction.name ?? ''}`);
        try {
          await locator.waitFor({ state: 'visible', timeout: 15000 });
        } catch {
          console.warn(`[processInteraction] getByRole did not attach within timeout for role=${role}.`);
          continue;
        }
        config.triedActions.add(clickKey);
        await locator.first().click();
        await waitForAppReady(newPage).catch(() => {});
        const newNode = await capture(newPage);
        console.info(`[processInteraction] getByRole click produced state -> ${newNode.url}`);
        return newNode;
      }
      console.warn('[processInteraction] getByRole did not find a clickable candidate across role fallbacks. Abandon interaction.');
      return null;
    }
  } catch (e) {
    console.warn('[processInteraction] error:', e);
    return null;
  } finally {
    try { await newPage?.close(); } catch {}
  }
}

