import { URL } from 'node:url';

export function isInternalLink(targetUrl: string, baseUrl: string): boolean {
  try {
    const baseDomain = new URL(baseUrl).host;
    const targetDomain = new URL(targetUrl).host;
    return baseDomain === targetDomain;
  } catch {
    return false;
  }
}

export function normalizeUrl(inputUrl: string): string {
  try {
    const url = new URL(inputUrl);
    // Remove hash fragment
    url.hash = '';
    // Normalize default ports
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    // Remove trailing slash on pathname except root
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    // Sort query params for stability
    if (url.searchParams && [...url.searchParams.keys()].length > 0) {
      const params = Array.from(url.searchParams.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      url.search = '';
      for (const [k, v] of params) url.searchParams.append(k, v);
    }
    return url.toString();
  } catch {
    return inputUrl;
  }
}

// Extract first ref id from textual snapshot_for_ai content.
// Supports formats like: "[ref=abc123]", "ref: abc123", "ref: 'abc123'", "ref: \"abc123\""
export function extractRefIdFromSnapshot(snapshotText: string): string | null {
  try {
    // 1) [ref=...] pattern
    const bracket = /\[\s*ref\s*=\s*([\w:-]+)\s*\]/i.exec(snapshotText);
    if (bracket?.[1]) return bracket[1];

    // 2) YAML/JSON-like key-value: ref: value
    const kvQuoted = /\bref\s*:\s*['"]([^'"\s]+)['"]/i.exec(snapshotText);
    if (kvQuoted?.[1]) return kvQuoted[1];

    const kvBare = /\bref\s*:\s*([\w:-]+)/i.exec(snapshotText);
    if (kvBare?.[1]) return kvBare[1];
  } catch {}
  return null;
}

export async function gatherWithBatches<T>(tasks: Array<() => Promise<T>>, batchSize: number): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize).map((fn) => fn());
    const batchResults = await Promise.allSettled(batch);
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }
  return results;
}

