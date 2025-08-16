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

export function findRoleAndNameByRef(
  snapshotText: string,
  refId: string,
): { role: string; name?: string } | null {
  try {
    const lines = snapshotText.split(/\r?\n/);
    const refToken = `[ref=${refId}]`;
    let foundIndex = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.includes(refToken)) {
        foundIndex = i;
        break;
      }
    }
    if (foundIndex === -1) return null;

    // Try to extract role and name from the same line
    const line = lines[foundIndex]!;
    const sameLineMatch = /-\s*([a-zA-Z]+)(?:\s+"([^"]+)")?[^\n]*\[ref=([\w:-]+)\]/.exec(line);
    if (sameLineMatch) {
      const role = sameLineMatch[1]!.toLowerCase();
      const name = sameLineMatch[2];
      if (role && role !== 'generic') {
        const out: { role: string; name?: string } = { role };
        if (name && name.trim().length > 0) out.name = name;
        return out;
      }
      if (role) {
        if (name && name.trim().length > 0) return { role, name };
      }
    }

    // Fallback: look upward for a meaningful ancestor line with a role and optional name
    for (let j = foundIndex - 1; j >= Math.max(0, foundIndex - 10); j -= 1) {
      const l = lines[j]!;
      const m = /-\s*([a-zA-Z]+)(?:\s+"([^"]+)")?/.exec(l);
      if (m) {
        const role = m[1]!.toLowerCase();
        const name = m[2];
        if (role && role !== 'generic') {
          const out: { role: string; name?: string } = { role };
          if (name && name.trim().length > 0) out.name = name;
          return out;
        }
      }
    }
  } catch {}
  return null;
}


