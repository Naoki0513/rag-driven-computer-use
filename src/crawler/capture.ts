import type { Page } from 'playwright';
import { captureNode } from '../utilities/snapshots.js';

export async function capture(page: Page, baseUrl?: string): Promise<{ url: string; snapshotForAI: string }>{
  const options: { depth: number; baseUrl?: string } = { depth: 0 };
  if (baseUrl !== undefined) {
    options.baseUrl = baseUrl;
  }
  const node = await captureNode(page, options);
  return { url: node.url, snapshotForAI: node.snapshotForAI };
}


