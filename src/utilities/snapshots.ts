import type { Page } from 'playwright';
import type { NodeState } from './types.js';
import { normalizeUrl } from './url.js';
import { computeSha256Hex } from './text.js';
import { getTimeoutMs } from './timeout.js';

export async function captureNode(page: Page, options: { depth: number }): Promise<NodeState> {
  const t = getTimeoutMs('crawler');
  // SPA/WS 重めページでも進むように、networkidle 依存を避けて段階的に待機
  try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
  try { await page.waitForLoadState('load', { timeout: Math.min(t, 10000) }); } catch {}
  await page.waitForTimeout(Math.min(1500, t));

  const rawUrl = page.url();
  const normalizedUrl = normalizeUrl(rawUrl);
  // 代表的なUIが現れるまで軽く待機（Slack/Rocket.Chat系）
  try {
    await page.waitForSelector('.rc-room, .rc-message-box, .sidebar, main', { state: 'attached', timeout: Math.min(3000, t) });
  } catch {}
  const snapshotForAI = await getSnapshotForAI(page);
  const urlObj = new URL(normalizedUrl);
  const site = `${urlObj.protocol}//${urlObj.host}`;
  const snapshotHash = computeSha256Hex(snapshotForAI);

  try {
    if (!snapshotForAI || snapshotForAI.trim().length === 0) {
      console.warn(`[captureNode] snapshotForAI is empty for ${normalizedUrl}`);
    }
  } catch {}

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
  if (typeof pw._snapshotForAI === 'function') {
    const text = await pw._snapshotForAI();
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  // フォールバック: DOM からクリック可能要素の概要を抽出
  const fallback = await page.evaluate(() => {
    function getAccessibleName(el: Element): string {
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria) return aria;
      const title = (el.getAttribute('title') || '').trim();
      if (title) return title;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return text || '';
    }
    function roleOf(el: Element): string {
      const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && (el as HTMLAnchorElement).hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      return 'button';
    }
    const elements = Array.from(document.querySelectorAll('a[href], button, [role="button"], [role="tab"], [role="menuitem"]'));
    const lines: string[] = [];
    let idx = 0;
    for (const el of elements) {
      const role = roleOf(el);
      const name = getAccessibleName(el) || `${role}#${idx+1}`;
      const ref = `ref-${idx+1}`;
      lines.push(`- ${role} "${name}" [cursor=pointer] [ref=${ref}]`);
      const href = (el as HTMLAnchorElement).getAttribute('href');
      if (href) {
        lines.push(`  href: ${href}`);
      }
      idx += 1;
    }
    return lines.join('\n');
  });
  return typeof fallback === 'string' ? fallback : '';
}


