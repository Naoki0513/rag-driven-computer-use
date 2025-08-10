import yaml from 'js-yaml';
import type { Interaction, NodeState } from './types.js';
import { isInternalLink, normalizeUrl, extractRefIdFromSnapshot } from './utils.js';
import type { BrowserContext, Page } from 'playwright';

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
        interactions.push({
          selector: null,
          text: name,
          actionType: 'click',
          href: null,
          role,
          name,
          refId: typeof node?.ref === 'string' ? node.ref : extractRefIdFromSnapshot(yaml.dump(node, { noRefs: true })),
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
      interactions.push({
        selector: null,
        text: name,
        actionType: 'click',
        href: null,
        role,
        name,
        refId: extractRefIdFromSnapshot(line),
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
  const newPage = await context.newPage();
  try {
    await newPage.goto(fromNode.url, { waitUntil: 'networkidle' });
    await newPage.waitForTimeout(5000);

    const options: Parameters<Page['getByRole']>[1] = { exact: true } as any;
    if (interaction.name) (options as any).name = interaction.name;
    const locator = newPage.getByRole(interaction.role as any, options as any);
    try {
      await locator.waitFor({ state: 'attached', timeout: 10000 });
    } catch {
      return null;
    }

    const href = await locator.getAttribute('href');
    if (href) {
      const targetUrl = normalizeUrl(new URL(href, fromNode.url).toString());
      if (!isInternalLink(targetUrl, config.targetUrl)) return null;
      if (config.visitedUrls?.has(targetUrl)) return null;
      const actionKey = `nav:${interaction.role ?? ''}:${interaction.name ?? ''}:${targetUrl}`;
      if (config.triedActions?.has(actionKey)) return null;
      config.triedActions?.add(actionKey);
      await newPage.goto(targetUrl, { waitUntil: 'networkidle' });
    } else {
      const actionKey = `click:${interaction.role ?? ''}:${interaction.name ?? ''}:${fromNode.url}`;
      if (config.triedActions?.has(actionKey)) return null;
      config.triedActions?.add(actionKey);
      await locator.click();
      await newPage.waitForLoadState('networkidle').catch(() => {});
    }

    const { captureNode } = await import('./snapshots.js');
    const newNode = await captureNode(newPage, { maxHtmlSize: 100 * 1024 });
    return newNode;
  } catch (e) {
    console.warn('processInteraction error:', e);
    return null;
  } finally {
    await newPage.close();
  }
}

