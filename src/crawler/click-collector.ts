import type { Page } from 'playwright';
import { getTimeoutMs } from '../utilities/timeout.js';
import { interactionsFromSnapshot } from './interactions.js';
import { isInternalLink, normalizeUrl } from '../utilities/url.js';
import { capture } from './capture.js';
import { extractInternalUrlsFromSnapshot } from './url-extraction.js';

export function extractClickableElementSigs(snapshotText: string): Set<string> {
  const sigs = new Set<string>();
  try {
    const lines = snapshotText.split(/\r?\n/);
    for (const raw of lines) {
      const line = (raw ?? '').trim();
      if (!line.includes('[cursor=pointer]')) continue;
      const m = /^-\s*([A-Za-z]+)\s*(?:"([^"]+)")?/.exec(line);
      if (!m) continue;
      const role = (m[1] || '').toLowerCase();
      const name = (m[2] || '').trim().toLowerCase();
      if (!role) continue;
      if (!['button','link','tab','menuitem'].includes(role)) continue;
      sigs.add(`${role}|${name}`);
    }
  } catch {}
  return sigs;
}

export async function clickPointerAndCollect(
  page: Page,
  snapshotText: string,
  discovered: Set<string>,
  baseUrlSet: Set<string>,
  baseElemSet: Set<string>,
  baseUrl: string,
  path: string[],
  level: number,
  _firstMutatorSig: string | null = null,
  globalElemSigSet?: Set<string>,
  config?: { targetUrl: string; maxUrls?: number; onDiscovered?: (url: string) => Promise<void> | void; shouldStop?: () => boolean }
): Promise<void> {
  const t = getTimeoutMs('crawler');
  const rootUrl = normalizeUrl(page.url());
  const interactions = await interactionsFromSnapshot(snapshotText);
  const allowed = new Set(['button', 'tab', 'menuitem']);
  const candidates = interactions.filter((i) => i.ref && i.role && allowed.has((i.role || '').toLowerCase()));
  try { console.info(`[root=${rootUrl}] [level=${level}] [path=${path.join(' > ')}] candidates=${candidates.length}`); } catch {}
  for (let idx = 0; idx < candidates.length; idx += 1) {
    if (config?.shouldStop?.()) {
      try { console.info(`[root=${rootUrl}] [level=${level}] shouldStop=true; stop clicking`); } catch {}
      return;
    }
    const it = candidates[idx]!;
    const roleLower = (it.role || '').toLowerCase();
    if (roleLower === 'link') continue;

    const labelName = (it.name || '').replace(/\s+/g, ' ').trim();
    const refStr = it.ref || it.refId || 'n/a';
    const pos = idx + 1;
    try { console.info(`[root=${rootUrl}] [level=${level}] [path=${path.join(' > ')}] try role=${it.role} name="${labelName}" ref=${refStr} idx=${pos}/${candidates.length}`); } catch {}

    const sig = `${roleLower}|${labelName}`.toLowerCase();
    if (level > 0 && baseElemSet.has(sig)) {
      try { console.info(`[root=${rootUrl}] [level=${level}] skip same base element sig=${sig}`); } catch {}
      continue;
    }
    if (globalElemSigSet && globalElemSigSet.has(sig)) {
      try { console.info(`[root=${rootUrl}] [level=${level}] skip global duplicate element sig=${sig}`); } catch {}
      continue;
    }
    if (globalElemSigSet) globalElemSigSet.add(sig);

    // 事前に href(/url) が既知か判定し、既知ならクリックを省略
    let predictedAbs: string | null = null;
    try {
      const hrefOrUrl = (it as any).href as string | null | undefined;
      if (hrefOrUrl) predictedAbs = normalizeUrl(new URL(hrefOrUrl, rootUrl).toString());
    } catch {}
    if (predictedAbs && isInternalLink(predictedAbs, baseUrl)) {
      if (baseUrlSet.has(predictedAbs) || discovered.has(predictedAbs)) {
        try { console.info(`[root=${rootUrl}] [level=${level}] skip click; predicted URL already known -> ${predictedAbs}`); } catch {}
        continue;
      }
      discovered.add(predictedAbs);
      try { console.info(`[root=${rootUrl}] [level=${level}] add new URL from href without click -> ${predictedAbs}`); } catch {}
      try { await config?.onDiscovered?.(predictedAbs); } catch {}
      continue;
    }

    try {
      const locator = page.getByRole(it.role as any, (it.name ? { name: it.name, exact: true } as any : undefined) as any).first();
      let isVisible = false;
      let isEnabled = false;
      try { isVisible = await locator.isVisible(); } catch {}
      try { isEnabled = await locator.isEnabled(); } catch {}
      try { console.info(`[root=${rootUrl}] [level=${level}] diagnostics visible=${isVisible} enabled=${isEnabled}`); } catch {}
      try { await locator.waitFor({ state: 'visible', timeout: Math.min(t, 2000) }); } catch { continue; }

      const urlWaiter = page
        .waitForFunction((prev) => window.location.href !== prev, rootUrl, { timeout: Math.min(t, 3000) })
        .then(() => true)
        .catch(() => false);

      await locator.click({ timeout: Math.min(t, 2000) });
      const changed = await urlWaiter;

      if (changed) {
        const newUrl = normalizeUrl(page.url());
        try { console.info(`[root=${rootUrl}] [level=${level}] URL changed -> ${newUrl}`); } catch {}
        if (isInternalLink(newUrl, baseUrl)) discovered.add(newUrl);
        try { await config?.onDiscovered?.(newUrl); } catch {}
        try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 5000) }); } catch {}
      } else {
        try { console.info(`[root=${rootUrl}] [level=${level}] no URL change; capturing snapshot for diff`); } catch {}
      }

      const full = await capture(page);
      const snapUrls = extractInternalUrlsFromSnapshot(full.snapshotForAI, full.url, baseUrl);
      const newUrls = snapUrls.filter((u) => !baseUrlSet.has(u));
      for (const u of newUrls) discovered.add(u);
      try { for (const u of newUrls) await config?.onDiscovered?.(u); } catch {}
      if (config?.shouldStop?.()) {
        try { console.info(`[root=${rootUrl}] [level=${level}] shouldStop=true; stop recursion`); } catch {}
        return;
      }

      const newElemSigs = extractClickableElementSigs(full.snapshotForAI);
      const novelElems = Array.from(newElemSigs).filter((s) => !baseElemSet.has(s));
      try { console.info(`[root=${rootUrl}] [level=${level}] new clickable elements after click: ${novelElems.length}`); for (const s of novelElems) console.info(`NEW-ELEM: ${s}`); } catch {}
      if (globalElemSigSet) for (const s of novelElems) globalElemSigSet.add(s.toLowerCase());

      if (changed) {
        try { console.info(`[root=${rootUrl}] [level=${level}] returning to original via reload -> ${rootUrl}`); } catch {}
        await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(t, 6000) }).catch(() => {});
        try { await page.waitForTimeout(200); } catch {}
      } else if (novelElems.length > 0) {
        const childBaseElems = new Set<string>([...baseElemSet, ...newElemSigs]);
        const childPath = [...path, `${it.role}:${labelName}`];
        await clickPointerAndCollect(page, full.snapshotForAI, discovered, new Set([...baseUrlSet, ...newUrls]), childBaseElems, baseUrl, childPath, level + 1, null, globalElemSigSet, config);
        if (level === 0) {
          try { console.info(`[root=${rootUrl}] [level=${level}] reload after level-1 exploration -> ${rootUrl}`); } catch {}
          try { await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(t, 6000) }); } catch {}
          try { await page.waitForTimeout(200); } catch {}
        }
      }
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      try { console.warn(`[root=${rootUrl}] [level=${level}] click failed role=${it.role} name="${labelName}" ref=${refStr} reason=${msg}`); } catch {}
    }
  }
}


