import { createHash } from 'node:crypto';

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


