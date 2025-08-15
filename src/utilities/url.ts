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


