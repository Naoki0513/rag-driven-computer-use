import type { Interaction } from '../utilities/types.js';

function buildFlexibleNameRegex(name: string | null | undefined): RegExp | null {
  if (!name) return null;
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped.replace(/[_\s]+/g, '\\s*').replace(/-+/g, '[-\\s_]*');
  return new RegExp(flexible, 'i');
}

export async function interactionsFromSnapshot(snapshotText: string): Promise<Interaction[]> {
  const interactions: Interaction[] = [];
  const seenRef = new Set<string>();
  const allowedRoles = new Set([
    'button',
    'link',
    'tab',
    'menuitem',
    'treeitem',
    'disclosure',
  ]);

  const lines = snapshotText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line.includes('[cursor=pointer]')) continue;
    if (!line.includes('[ref=')) continue;

    const roleMatch = /^-\s*([A-Za-z]+)\b/.exec(line);
    const role = (roleMatch?.[1] ?? '').toLowerCase();
    if (!role) continue;
    if (!allowedRoles.has(role)) continue;

    const refMatch = /\[\s*ref\s*=\s*([^\]\s]+)\s*\]/i.exec(line);
    const ref = refMatch?.[1] ?? null;
    if (!ref || seenRef.has(ref)) continue;

    const nameMatch = /^-\s*[A-Za-z]+\s+"([^"]+)"/.exec(line);
    const name = nameMatch?.[1] ?? null;

    let href: string | null = null;
    const indentMatch = /^(\s*)-\s/.exec(raw ?? '');
    const baseIndent = indentMatch?.[1]?.length ?? 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nxtRaw = lines[j] ?? '';
      const nxtTrim = (nxtRaw ?? '').trim();
      const nxtIndent = (/^(\s*)-\s/.exec(nxtRaw ?? '')?.[1]?.length) ?? 0;
      if (nxtTrim.startsWith('-') && nxtIndent <= baseIndent) break;
      const urlMatch = /(?:href|\/url)\s*:\s*([^\s]+)/i.exec(nxtTrim);
      if (urlMatch?.[1]) { 
        // 先頭と末尾のダブルクォート・シングルクォートを削除
        href = urlMatch[1].replace(/^["']+|["']+$/g, ''); 
        break; 
      }
    }

    seenRef.add(ref);
    interactions.push({ actionType: 'click', role, name, ref, href: href ?? null, refId: null });
  }

  try {
    console.info(`[interactionsFromSnapshot] extracted ${interactions.length} pointer interactions (unique by ref).`);
  } catch {}
  return interactions;
}


