import type { Page } from 'playwright';
import type { NodeState } from './types.js';
import { normalizeUrl } from './url.js';
import { computeSha256Hex } from './text.js';
import { getTimeoutMs } from './timeout.js';

export async function captureNode(page: Page, options: { depth: number; baseUrl?: string }): Promise<NodeState> {
  const t = getTimeoutMs('crawler');
  // SPA/WS 重めページでも進むように、networkidle 依存を避けて段階的に待機
  try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
  try { await page.waitForLoadState('load', { timeout: t }); } catch {}

  const rawUrl = page.url();
  const normalizedUrl = normalizeUrl(rawUrl);
  // 特定サイト用の待機は削除（一般的なサイトには不要）
  const snapshotForAI = await getSnapshotForAI(page);
  
  // baseUrlが指定されている場合はそれをsiteとして使用、なければ現在のURLから計算
  let site: string;
  if (options.baseUrl) {
    site = normalizeUrl(options.baseUrl);
  } else {
    const urlObj = new URL(normalizedUrl);
    site = `${urlObj.protocol}//${urlObj.host}`;
  }
  
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
  // フォールバック: DOM から主要な操作要素の概要を抽出（クリック系+フォーム要素）
  const fallback = await page.evaluate(() => {
    function getAccessibleName(el: Element): string {
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria) return aria;
      const title = (el.getAttribute('title') || '').trim();
      if (title) return title;
      // label 要素の関連付け
      try {
        const id = (el as HTMLElement).id;
        if (id) {
          const byFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (byFor) {
            const t = (byFor.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) return t;
          }
        }
      } catch {}
      // 祖先 label
      try {
        const label = el.closest('label');
        if (label) {
          const t = (label.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
      } catch {}
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return text || '';
    }
    function roleOf(el: Element): string {
      const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && (el as HTMLAnchorElement).hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const type = ((el as HTMLInputElement).type || '').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      return 'generic';
    }
    const elements = Array.from(document.querySelectorAll(
      [
        'a[href]',
        'button',
        '[role="button"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="link"]',
        '[role="treeitem"]',
        '[role="disclosure"]',
        'input',
        'select',
        'textarea',
        'label'
      ].join(', ')
    ));
    const lines: string[] = [];
    let idx = 0;
    for (const el of elements) {
      const role = roleOf(el);
      const name = getAccessibleName(el) || `${role}#${idx+1}`;
      const ref = `ref-${idx+1}`;
      const pointer = role === 'textbox' || role === 'combobox' || role === 'checkbox' || role === 'radio' ? 'input' : 'pointer';
      lines.push(`- ${role} "${name}" [cursor=${pointer}] [ref=${ref}]`);
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


