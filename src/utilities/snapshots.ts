import type { Page } from 'playwright';
import type { NodeState } from './types.js';
import { normalizeUrl } from './url.js';
import { computeSha256Hex } from './text.js';
import { getTimeoutMs } from './timeout.js';
import { NodeHtmlMarkdown } from 'node-html-markdown';

export async function captureNode(page: Page, options: { depth: number }): Promise<NodeState> {
  const t = getTimeoutMs();
  await page.waitForLoadState('networkidle', { timeout: t });
  await page.waitForTimeout(Math.min(3000, t));

  const rawUrl = page.url();
  const normalizedUrl = normalizeUrl(rawUrl);
  const html = await page.content();
  const snapshotInMd = convertHtmlToMarkdown(html);
  const snapshotForAI = await getSnapshotForAI(page);
  const urlObj = new URL(normalizedUrl);
  const site = `${urlObj.protocol}//${urlObj.host}`;
  const snapshotHash = computeSha256Hex(snapshotForAI);

  return {
    site,
    url: normalizedUrl,
    snapshotForAI,
    snapshotInMd,
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

function convertHtmlToMarkdown(html: string): string {
  try {
    // 目に見える内容に不要なタグを除去
    const cleaned = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

    const md = NodeHtmlMarkdown.translate(cleaned, {
      keepDataImages: false,
      useLinkReferenceDefinitions: false,
      maxConsecutiveNewlines: 2,
    } as any);
    return (md || '').trim();
  } catch {
    return '';
  }
}


