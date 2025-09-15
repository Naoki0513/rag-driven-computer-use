import type { Page } from 'playwright';
import { captureNode } from '../utilities/snapshots.js';

export async function capture(page: Page): Promise<{ url: string; snapshotForAI: string }>{
  const node = await captureNode(page, { depth: 0 });
  return { url: node.url, snapshotForAI: node.snapshotForAI };
}


