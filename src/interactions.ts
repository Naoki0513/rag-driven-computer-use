import type { Interaction, NodeState } from './types.js';
import { isInternalLink, normalizeUrl } from './utils.js';
import type { BrowserContext, Page } from 'playwright';
// Removed getSnapshotForAI import since clickByRef-based re-resolution is now used

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
  // テキストベースのスナップショットから、[cursor=pointer] かつ [ref=...] を持つ行のみを抽出
  const interactions: Interaction[] = [];
  const seenRef = new Set<string>();
  const allowedRoles = new Set(['button', 'link', 'tab', 'menuitem']);

  const lines = snapshotText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line.includes('[cursor=pointer]')) continue;
    if (!line.includes('[ref=')) continue;

    // 例: "- link \"random\" [ref=e49] [cursor=pointer]:"
    const roleMatch = /^-\s*([A-Za-z]+)\b/.exec(line);
    const role = (roleMatch?.[1] ?? '').toLowerCase();
    if (!role) continue;
    if (!allowedRoles.has(role)) continue;

    const refMatch = /\[\s*ref\s*=\s*([^\]\s]+)\s*\]/i.exec(line);
    const ref = refMatch?.[1] ?? null;
    if (!ref || seenRef.has(ref)) continue;

    const nameMatch = /^-\s*[A-Za-z]+\s+"([^"]+)"/.exec(line);
    const name = nameMatch?.[1] ?? null;

    // 同じブロック内の /url: or href: を拾う（次の同レベルの項目まで）
    let href: string | null = null;
    const indentMatch = /^(\s*)-\s/.exec(raw ?? '');
    const baseIndent = indentMatch?.[1]?.length ?? 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nxtRaw = lines[j] ?? '';
      const nxtTrim = (nxtRaw ?? '').trim();
      const nxtIndent = (/^(\s*)-\s/.exec(nxtRaw ?? '')?.[1]?.length) ?? 0;
      if (nxtTrim.startsWith('-') && nxtIndent <= baseIndent) break;
      const urlMatch = /(?:href|\/url)\s*:\s*([^\s]+)/i.exec(nxtTrim);
      if (urlMatch?.[1]) { href = urlMatch[1]; break; }
    }

    seenRef.add(ref);
    interactions.push({ actionType: 'click', role, name, ref, href: href ?? null, refId: null });
  }

  try {
    console.info(`[interactionsFromSnapshot] extracted ${interactions.length} pointer interactions (unique by ref).`);
  } catch {}
  return interactions;
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
    if (!ref) {
      console.warn('[processInteraction] no ref provided; skip interaction.');
      return null;
    }

    // 1) href ナビゲーションを優先（存在すれば実行）。内部リンクのみ対象。
    const hrefCandidate = interaction.href ?? findHrefByRef(fromNode.snapshotForAI, ref);
    if (hrefCandidate) {
      try {
        const targetUrl = normalizeUrl(new URL(hrefCandidate, fromNode.url).toString());
        if (isInternalLink(targetUrl, config.targetUrl)) {
          const key = `nav:href:${targetUrl}`;
          if (!config.triedActions.has(key) && !config.visitedUrls.has(targetUrl)) {
            config.triedActions.add(key);
            console.info(`[processInteraction] primary href navigation -> ${targetUrl}`);
            interaction.href = targetUrl;
            await newPage.goto(targetUrl, { waitUntil: 'networkidle' });
            const newNode = await capture(newPage);
            return newNode;
          }
        }
      } catch {}
      // href が外部/既訪問/既試行などの場合は getByRole にフォールバック
    }

    // 2) getByRole フォールバック（ref から role/name を再解決）
    const resolved = findRoleAndNameByRef(fromNode.snapshotForAI, ref);
    if (!resolved) {
      console.warn(`[processInteraction] ref ${ref} not resolvable to a pointer role+name; skip.`);
      return null;
    }
    interaction.role = resolved.role;
    interaction.name = resolved.name;
    interaction.href = null;

    const nameRegex = buildFlexibleNameRegex(resolved.name);
    const options: Parameters<Page['getByRole']>[1] = {} as any;
    if (nameRegex) (options as any).name = nameRegex;

    const clickKey = `click:role:${resolved.role}:name:${resolved.name ?? ''}:url:${fromNode.url}`;
    if (config.triedActions.has(clickKey)) {
      console.info(`[processInteraction] skip getByRole click (already tried) key=${clickKey}`);
      return null;
    }
    config.triedActions.add(clickKey);

    const locator = newPage.getByRole(resolved.role as any, options as any);
    try {
      await locator.first().waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      console.warn(`[processInteraction] getByRole fallback target not visible role=${resolved.role}, name=${resolved.name ?? ''}`);
      return null;
    }

    await locator.first().click();
    await waitForAppReady(newPage).catch(() => {});
    const newNode = await capture(newPage);
    console.info(`[processInteraction] getByRole fallback produced state -> ${newNode.url}`);
    return newNode;
  } catch (e) {
    console.warn('[processInteraction] error:', e);
    return null;
  } finally {
    try { await newPage?.close(); } catch {}
  }
}

// ref からロールとネームを再解決（[cursor=pointer] の行に限定）
function findRoleAndNameByRef(snapshotText: string, refId: string): { role: string; name: string | null } | null {
  const allowedRoles = new Set(['button', 'link', 'tab', 'menuitem']);
  const lines = snapshotText.split(/\r?\n/);
  for (const rawItem of lines) {
    const raw = rawItem ?? '';
    const line = raw.trim();
    if (!line.includes(`[ref=${refId}]`)) continue;
    if (!line.includes('[cursor=pointer]')) return null; // ref はあるが pointer でない
    const roleMatch = /^-\s*([A-Za-z]+)\b/.exec(line ?? '');
    const role = (roleMatch?.[1] ?? '').toLowerCase();
    if (!role) return null;
    if (!allowedRoles.has(role)) return null;
    const nameMatch = /^-\s*[A-Za-z]+\s+"([^"]+)"/.exec(line ?? '');
    const name = nameMatch?.[1] ?? null;
    return { role, name };
  }
  return null;
}

function findHrefByRef(snapshotText: string, refId: string): string | null {
  const lines = snapshotText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = (raw ?? '').trim();
    if (!line.includes(`[ref=${refId}]`)) continue;
    const indentMatch = /^(\s*)-\s/.exec(raw ?? '');
    const baseIndent = indentMatch?.[1]?.length ?? 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nxtRaw = lines[j] ?? '';
      const nxtTrim = (nxtRaw ?? '').trim();
      const nxtIndent = (/^(\s*)-\s/.exec(nxtRaw ?? '')?.[1]?.length) ?? 0;
      if (nxtTrim.startsWith('-') && nxtIndent <= baseIndent) break;
      const urlMatch = /(?:href|\/url)\s*:\s*([^\s]+)/i.exec(nxtTrim);
      if (urlMatch?.[1]) return urlMatch[1];
    }
    break;
  }
  return null;
}

