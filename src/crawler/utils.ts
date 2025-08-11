import { URL } from 'node:url';
import { createHash } from 'node:crypto';

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
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
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

export function parseSiteAndRoute(inputUrl: string): { site: string; route: string } {
  try {
    const url = new URL(normalizeUrl(inputUrl));
    const origin = `${url.protocol}//${url.host}`;
    const route = `${url.pathname}${url.search}` || '/';
    return { site: origin, route: route || '/' };
  } catch {
    return { site: '', route: inputUrl };
  }
}

export function buildUrl(site: string, route: string): string {
  const cleanSite = site.replace(/\/$/, '');
  const cleanRoute = route.startsWith('/') ? route : `/${route}`;
  return normalizeUrl(`${cleanSite}${cleanRoute}`);
}

export function extractRefIdFromSnapshot(snapshotText: string): string | null {
  try {
    const bracket = /\[\s*ref\s*=\s*([\w:-]+)\s*\]/i.exec(snapshotText);
    if (bracket?.[1]) return bracket[1];
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

export function computeSha256Hex(text: string): string {
  try {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  } catch {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return `fallback_${hash.toString(16)}`;
  }
}


