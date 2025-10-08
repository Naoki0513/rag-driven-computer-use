import { URL } from 'node:url';

export function isInternalLink(targetUrl: string, baseUrl: string): boolean {
  try {
    const baseUrlObj = new URL(baseUrl);
    const targetUrlObj = new URL(targetUrl);
    
    // ホストが異なる場合は対象外
    if (baseUrlObj.host !== targetUrlObj.host) {
      return false;
    }
    
    // ベースURLのパスを取得（末尾スラッシュを正規化）
    let basePath = baseUrlObj.pathname;
    if (basePath !== '/' && !basePath.endsWith('/')) {
      basePath += '/';
    }
    
    // ターゲットURLのパスを取得
    let targetPath = targetUrlObj.pathname;
    if (targetPath !== '/' && !targetPath.endsWith('/')) {
      targetPath += '/';
    }
    
    // ベースURLが '/' の場合は、同一ホストならすべて対象
    if (basePath === '/') {
      return true;
    }
    
    // ターゲットがベースパスで始まるかチェック
    return targetPath.startsWith(basePath) || targetUrlObj.pathname === baseUrlObj.pathname;
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

// 競合判定用の正規化キー（大文字小文字無視・クエリ無視・フラグメント無視）
export function canonicalUrlKey(inputUrl: string): string {
  try {
    const url = new URL(inputUrl);
    // スキーム・ホスト・パスを小文字化（パスの大小文字差異も同一とみなす要件のため）
    const protocol = (url.protocol || '').toLowerCase();
    const hostname = (url.hostname || '').toLowerCase();
    let pathname = (url.pathname || '/').toLowerCase();
    // 末尾スラッシュ統一
    if (pathname !== '/' && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');
    // 既定ポート除去
    const isDefaultHttp = protocol === 'http:' && (url.port === '' || url.port === '80');
    const isDefaultHttps = protocol === 'https:' && (url.port === '' || url.port === '443');
    const port = isDefaultHttp || isDefaultHttps ? '' : (url.port || '');
    // クエリ・フラグメントは無視
    const auth = url.username ? `${url.username}${url.password ? ':' + url.password : ''}@` : '';
    const hostport = port ? `${hostname}:${port}` : hostname;
    return `${protocol}//${auth}${hostport}${pathname}`;
  } catch {
    try {
      // 失敗時もラフに小文字化・フラグメント/クエリ除去
      const base = String(inputUrl || '').trim().toLowerCase();
      return base.split('#')[0]!.split('?')[0] || base;
    } catch {
      return inputUrl;
    }
  }
}


