import { isInternalLink, normalizeUrl } from '../utilities/url.js';

export function extractInternalUrlsFromSnapshot(snapshotText: string, fromUrl: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const lines = snapshotText.split(/\r?\n/);
  for (const raw of lines) {
    const line = (raw ?? '').trim();
    // /url または href を収集（末尾に句読点や括弧が続くケースも想定して非空白連続+末尾句読点除去）
    const m = /(?:\/url|href)\s*:\s*([^\s]+)/i.exec(line);
    if (!m) continue;
    let rawUrl = (m[1] ?? '').trim();
    if (!rawUrl) continue;
    // 末尾の , ; ) ] を緩やかに削除
    rawUrl = rawUrl.replace(/[),;\]]+$/g, '');
    let abs: string;
    try {
      abs = new URL(rawUrl, fromUrl).toString();
    } catch {
      continue;
    }
    const norm = normalizeUrl(abs);
    if (isInternalLink(norm, baseUrl)) urls.push(norm);
  }
  // デバッグ: 件数と最初の数件をログ
  try {
    const uniq = Array.from(new Set(urls));
    if ((process.env.DEBUG_SNAPSHOT_URLS || '').toLowerCase() === 'true') {
      console.info(`[extractInternalUrlsFromSnapshot] found internal=${uniq.length} from=${normalizeUrl(fromUrl)}`);
      for (const u of uniq.slice(0, 10)) console.info(`  -> ${u}`);
    }
    return uniq;
  } catch {
    return Array.from(new Set(urls));
  }
}


