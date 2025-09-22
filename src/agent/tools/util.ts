import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Locator } from 'playwright';
import { captureNode, getSnapshotForAI } from '../../utilities/snapshots.js';
import { getTimeoutMs } from '../../utilities/timeout.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { promises as fs } from 'fs';
import path from 'path';
import { BedrockAgentRuntimeClient, RerankCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { recordRerankCallStart, recordRerankCallSuccess, recordRerankCallError, recordRerankUsage } from '../observability.js';

// 共有ブラウザ管理（単一の Browser/Context/Page を使い回す）
let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;

export async function ensureSharedBrowserStarted(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (sharedBrowser && sharedContext && sharedPage) {
    return { browser: sharedBrowser, context: sharedContext, page: sharedPage };
  }
  const headful = String(process.env.AGENT_HEADFUL ?? 'false').toLowerCase() === 'true';
  sharedBrowser = await chromium.launch({ headless: !headful });
  sharedContext = await sharedBrowser.newContext();
  const t = getTimeoutMs('agent');
  try { (sharedContext as any).setDefaultTimeout?.(t); } catch {}
  try { (sharedContext as any).setDefaultNavigationTimeout?.(t); } catch {}
  sharedPage = await sharedContext.newPage();
  try { sharedPage.setDefaultTimeout(t); } catch {}
  try { sharedPage.setDefaultNavigationTimeout(t); } catch {}
  console.log('[OK] 共有 Playwright ブラウザを起動しました');
  return { browser: sharedBrowser, context: sharedContext, page: sharedPage };
}

export async function closeSharedBrowserWithDelay(delayMs?: number): Promise<void> {
  const ms = Number.isFinite(Number(process.env.AGENT_BROWSER_CLOSE_DELAY_MS))
    ? Number(process.env.AGENT_BROWSER_CLOSE_DELAY_MS)
    : (typeof delayMs === 'number' ? delayMs : 5000);
  if (sharedBrowser) {
    try {
      console.log(`ブラウザを ${ms}ms 後にクローズします...`);
      await new Promise((r) => setTimeout(r, ms));
      await sharedBrowser.close();
      console.log('ブラウザをクローズしました');
    } catch (e: any) {
      console.log(`ブラウザクローズ時エラー: ${String(e?.message ?? e)}`);
    } finally {
      sharedBrowser = null;
      sharedContext = null;
      sharedPage = null;
      // ToDo ファイルの削除（同タイミング）
      try {
        const filePath = path.resolve(process.cwd(), 'todo.md');
        await fs.unlink(filePath).catch(() => {});
        console.log('ToDo ファイル(todo.md)を削除しました');
      } catch {}
    }
  }
}

export async function takeSnapshots(page: Page): Promise<{ text: string; hash: string; url: string }> {
  // クローラと同一の取得手順（networkidle 待機 + 追加待機）で撮影する
  const node = await captureNode(page, { depth: 0 });
  return { text: node.snapshotForAI, hash: node.snapshotHash, url: node.url };
}

// エラーメッセージを一貫フォーマット（短く、先頭に識別可能な接頭辞）
export function formatToolError(err: unknown, maxLen: number = 180): string {
  const raw = typeof err === 'string' ? err : String((err as any)?.message ?? err);
  const msg = raw.replace(/\s+/g, ' ').trim();
  const head = msg.length > maxLen ? msg.slice(0, maxLen).trimEnd() + '…' : msg;
  return `エラー: ${head}`;
}

// ===== スナップショット解決用の共通管理 =====
let latestResolutionSnapshotText: string | null = null;

export function getResolutionSnapshotText(): string | null {
  return latestResolutionSnapshotText;
}

export function setResolutionSnapshotText(text: string | null): void {
  latestResolutionSnapshotText = (typeof text === 'string' && text.trim().length > 0) ? text : null;
}

export function invalidateResolutionSnapshot(): void {
  latestResolutionSnapshotText = null;
}

export async function captureAndStoreSnapshot(page: Page): Promise<{ text: string; hash: string; url: string }> {
  // ユーザー指示: 撮影前にキャッシュ（本モジュールの保持テキスト）を無効化してから取得
  invalidateResolutionSnapshot();
  const snaps = await takeSnapshots(page);
  setResolutionSnapshotText(snaps.text);
  return snaps;
}

// クリック専用の堅牢フォールバック（スクロール→関連label→force）
export async function clickWithFallback(
  page: Page,
  locator: Locator,
  isCheckbox: boolean,
  attemptTimeoutMs?: number,
  errorsCollector?: string[],
): Promise<void> {
  const envTimeout = getTimeoutMs('agent');
  const t = Number.isFinite(Number(attemptTimeoutMs)) && Number(attemptTimeoutMs) > 0
    ? Math.trunc(Number(attemptTimeoutMs))
    : envTimeout;
  // checkbox は label クリックを最優先に試す（長い待ちを避ける）
  if (isCheckbox) {
    try {
      const id = await locator.getAttribute('id');
      if (id) {
        const labelByFor = page.locator(`label[for="${id}"]`).first();
        if (await labelByFor.count()) {
          await labelByFor.scrollIntoViewIfNeeded();
          await labelByFor.click({ timeout: t });
          return;
        }
      }
      const ancestorLabel = locator.locator('xpath=ancestor::label').first();
      if (await ancestorLabel.count()) {
        await ancestorLabel.scrollIntoViewIfNeeded();
        await ancestorLabel.click({ timeout: t });
        return;
      }
    } catch (e: any) { if (errorsCollector) errorsCollector.push(`[checkbox:label] ${formatToolError(e)}`); }
  }

  // 1) 通常クリック（短いタイムアウト）
  try { await locator.click({ timeout: t }); return; } catch (e: any) { if (errorsCollector) errorsCollector.push(`[click] ${formatToolError(e)}`); }

  // 2) スクロールして再試行（短いタイムアウト）
  try { await locator.scrollIntoViewIfNeeded(); await locator.click({ timeout: t }); return; } catch (e: any) { if (errorsCollector) errorsCollector.push(`[scroll+click] ${formatToolError(e)}`); }

  // 3) checkbox なら最後にもう一度 label 経由を試す
  if (isCheckbox) {
    try {
      const id = await locator.getAttribute('id');
      if (id) {
        const labelByFor = page.locator(`label[for="${id}"]`).first();
        if (await labelByFor.count()) {
          await labelByFor.scrollIntoViewIfNeeded();
          await labelByFor.click({ timeout: t });
          return;
        }
      }
      const ancestorLabel = locator.locator('xpath=ancestor::label').first();
      if (await ancestorLabel.count()) {
        await ancestorLabel.scrollIntoViewIfNeeded();
        await ancestorLabel.click({ timeout: t });
        return;
      }
    } catch (e: any) { if (errorsCollector) errorsCollector.push(`[checkbox:label:retry] ${formatToolError(e)}`); }
  }

  // 4) 最終手段: force クリック（無条件に実行）
  if (errorsCollector) errorsCollector.push('[force] 前段のクリックがすべて失敗したため force クリックにフォールバックしました');
  await locator.click({ force: true });
}

// ref → DOM ロケーター解決
// ユーザー指示に基づき、操作直前に getSnapshotForAI を呼ばず、
// 呼び出し側から渡されたスナップショットテキストのみを用いたフォールバックに限定する。
export async function resolveLocatorByRef(
  page: Page,
  ref: string,
  opts?: { resolutionSnapshotText?: string },
): Promise<Locator | null> {
  const t = getTimeoutMs('agent');

  // 0) data 属性が既に付与されていれば最優先
  try {
    const byAttr = page.locator(`[data-wg-ref="${ref}"]`).first();
    if ((await byAttr.count()) > 0) return byAttr;
  } catch {}

  // 1) ページ内のサイドカー索引（任意実装）
  try {
    const idx = await page.evaluate((r: string) => (window as any).__WG_REF_INDEX__?.[r], ref).catch(() => null as any);
    if (idx?.css) {
      const byCss = page.locator(idx.css).first();
      if ((await byCss.count()) > 0) {
        try { await byCss.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return byCss;
      }
    }
    if (idx?.xpath) {
      const byXpath = page.locator(`xpath=${idx.xpath}`).first();
      if ((await byXpath.count()) > 0) {
        try { await byXpath.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return byXpath;
      }
    }
    if (idx?.role && Number.isFinite(idx.roleIndex)) {
      const loc = page.getByRole(idx.role as any);
      const nth = loc.nth(Math.max(0, Math.trunc(idx.roleIndex)));
      if ((await nth.count()) > 0) {
        try { await nth.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return nth;
      }
    }
  } catch {}

  // 2) 呼び出し側から渡されたスナップショットを用いた序数ベース推定
  const snapText: string | null = (opts && typeof opts.resolutionSnapshotText === 'string')
    ? opts.resolutionSnapshotText
    : null;
  if (!snapText) return null;

  // パース: 行単位にして ref を含む行を特定
  const lines = snapText.split(/\r?\n/);
  const refToken = `[ref=${ref}]`;
  let targetIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.includes(refToken)) { targetIdx = i; break; }
  }
  if (targetIdx === -1) return null;

  // 役割抽出（同ファイルの findRoleAndNameByRef を流用）
  const rn = findRoleAndNameByRef(snapText, ref);
  const role = rn?.role || '';
  const name = rn?.name || '';

  // 祖先候補（ロール名・スナップショット行・インデント）を収集（近い順に最大5件）
  type AncestorCandidate = { role: string; lineIndex: number; indent: number };
  const ancestorCandidates: AncestorCandidate[] = [];
  for (let j = targetIdx - 1; j >= 0 && ancestorCandidates.length < 5; j -= 1) {
    const lineJ = lines[j]!;
    const m = /-\s*([a-zA-Z]+)(?:\s+"[^"]+")?.*\[ref=/.exec(lineJ);
    if (m) {
      const r = m[1]!.toLowerCase();
      if (['generic', 'text', 'separator', 'figure', 'img'].includes(r)) continue;
      const mIndent = /^(\s*)-/.exec(lineJ);
      const indent = mIndent ? (mIndent[1]?.length ?? 0) : 0;
      ancestorCandidates.push({ role: r, lineIndex: j, indent });
    }
  }

  // 同ロールの序数（スナップショット内での出現順）を求める
  function computeRoleIndex(targetLineIndex: number, roleName: string): number {
    let count = 0;
    const roleRegex = new RegExp(`-\\s*${roleName}(\\s|\\[|\\")`, 'i');
    for (let i = 0; i <= targetLineIndex; i += 1) {
      if (roleRegex.test(lines[i]!)) count += 1;
    }
    return Math.max(0, count - 1);
  }

  // 祖先ロールの nth を順に試しながらスコープを狭める（祖先自身の nth はグローバル算出で十分）
  let scope: Locator | null = null;
  let scopeAncestorLineIndex: number | null = null;
  let scopeAncestorIndent: number = 0;
  try {
    for (const a of ancestorCandidates) {
      const aIdx = computeRoleIndex(a.lineIndex, a.role);
      const aLoc = page.getByRole(a.role as any).nth(aIdx);
      const exists = (await aLoc.count()) > 0;
      if (exists) {
        scope = aLoc;
        scopeAncestorLineIndex = a.lineIndex;
        scopeAncestorIndent = a.indent;
        break;
      }
    }
  } catch {}

  // スコープ内序数を算出（スコープが無ければ従来のグローバル序数を使用）
  function computeRoleIndexWithinScope(
    ancestorLineIndex: number,
    ancestorIndent: number,
    targetLineIndex: number,
    roleName: string,
  ): number {
    let count = 0;
    const roleRegex = new RegExp(`-\\s*${roleName}(\\s|\\[|\\")`, 'i');
    for (let i = ancestorLineIndex + 1; i <= targetLineIndex; i += 1) {
      const li = lines[i]!;
      const mIndent = /^(\s*)-/.exec(li);
      const indent = mIndent ? (mIndent[1]?.length ?? 0) : 0;
      if (indent <= ancestorIndent) continue; // スコープ外
      if (roleRegex.test(li)) count += 1;
    }
    return Math.max(0, count - 1);
  }

  // 最終ロケーター（スコープがあれば内部で、なければページ全体で）
  try {
    if (role) {
      const base = scope ?? page;
      // name がある場合は序数 nth を適用せず、role+name の first で解決する
      if (name) {
        const locByName = base.getByRole(role as any, { name, exact: true } as any).first();
        const existsByName = (await locByName.count()) > 0;
        if (existsByName) {
          try { await locByName.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
          return locByName;
        }
      }

      // name が無い場合のみ、スナップショット上の序数に基づいて nth を適用
      let loc = base.getByRole(role as any);
      const idx = (scope && scopeAncestorLineIndex !== null)
        ? computeRoleIndexWithinScope(scopeAncestorLineIndex, scopeAncestorIndent, targetIdx, role)
        : computeRoleIndex(targetIdx, role);
      loc = loc.nth(idx);
      const exists = (await loc.count()) > 0;
      if (exists) {
        try { await loc.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return loc;
      }
    }
  } catch {}

  // 役割が取れない場合の緩いフォールバック: 祖先スコープがあれば最初の入力要素
  try {
    if (scope) {
      const anyTextbox = scope.getByRole('textbox' as any).first();
      if ((await anyTextbox.count()) > 0) {
        try { await anyTextbox.first().evaluate((el: Element, r: string) => el.setAttribute('data-wg-ref', r), ref); } catch {}
        return anyTextbox;
      }
    }
  } catch {}

  return null;
}

// ===== ToDo 連携ユーティリティ =====
export async function readTodoFileContent(): Promise<{ path: string; content: string }> {
  const filePath = path.resolve(process.cwd(), 'todo.md');
  try {
    const buf = await fs.readFile(filePath);
    return { path: 'todo.md', content: buf.toString('utf-8') };
  } catch {
    return { path: 'todo.md', content: '' };
  }
}

export async function attachTodos<T extends Record<string, any>>(payload: T): Promise<T & { todos: { path: string; content: string } }>{
  try {
    const todos = await readTodoFileContent();
    return Object.assign(payload, { todos });
  } catch {
    return Object.assign(payload, { todos: { path: 'todo.md', content: '' } });
  }
}

// ===== スナップショット チャンク化 + リランク =====
type Line = { idx: number; indent: number; text: string; depth: number };

function parseLines(snapshot: string): Line[] {
  const out: Line[] = [];
  const stack: number[] = [];
  const lines = String(snapshot || '').split(/\r?\n/);
  const re = /^(\s*)-?\s*(.*)$/;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (!raw || !raw.trim()) continue;
    const m = re.exec(raw);
    const spaces = m ? (m[1] ?? '') : '';
    const rest = m ? (m[2] ?? '') : raw.trim();
    const indent = spaces.length;
    while (stack.length && indent < stack[stack.length - 1]!) stack.pop();
    if (!stack.length || indent > stack[stack.length - 1]!) stack.push(indent);
    const depth = Math.max(0, stack.length - 1);
    out.push({ idx: i, indent, text: rest.trim(), depth });
  }
  return out;
}

function splitByDepth(lines: Line[], start: number, end: number, targetDepth: number): Array<[number, number]> {
  const anchors: number[] = [];
  for (let i = start; i <= end; i += 1) if (lines[i]!.depth === targetDepth) anchors.push(i);
  if (!anchors.length) return [[start, end]];
  const segs: Array<[number, number]> = [];
  for (let j = 0; j < anchors.length; j += 1) {
    const a = anchors[j]!;
    const b = (j + 1 < anchors.length) ? (anchors[j + 1]! - 1) : end;
    segs.push([a, b]);
  }
  return segs;
}

function headerChain(lines: Line[], startIdx: number): string[] {
  const chain: string[] = [];
  let curDepth = lines[startIdx]!.depth - 1;
  let pos = startIdx - 1;
  const parents: Line[] = [];
  while (curDepth >= 0 && pos >= 0) {
    if (lines[pos]!.depth === curDepth) {
      parents.push(lines[pos]!);
      curDepth -= 1;
    }
    pos -= 1;
  }
  parents.reverse();
  let base = 0;
  for (const p of parents) {
    chain.push(`${' '.repeat(base)}- ${p.text}`);
    base += 2;
  }
  return chain;
}

function commonPrefix<T>(lists: T[][]): T[] {
  if (!lists.length) return [];
  const minLen = Math.min(...lists.map((l) => l.length));
  const out: T[] = [];
  for (let i = 0; i < minLen; i += 1) {
    const token = lists[0]![i]!;
    let ok = true;
    for (let k = 1; k < lists.length; k += 1) if (lists[k]![i] !== token) { ok = false; break; }
    if (!ok) break;
    out.push(token);
  }
  return out;
}

function buildChunkTextGrouped(lines: Line[], segs: Array<[number, number]>): string {
  const chains = segs.map(([s]) => headerChain(lines, s));
  const groups = new Map<string, Array<[number, number]>>();
  for (let i = 0; i < segs.length; i += 1) {
    const keyList = chains[i]!;
    const key = JSON.stringify(keyList);
    const list = groups.get(key) || [];
    list.push(segs[i]!);
    groups.set(key, list);
  }
  const ordered = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const chainLists = ordered.map(([k]) => JSON.parse(k) as string[]);
  const cp = commonPrefix(chainLists);
  const parts: string[] = [];
  if (cp.length) parts.push(...cp);
  for (let gi = 0; gi < ordered.length; gi += 1) {
    const chain = chainLists[gi]!;
    const seglist = ordered[gi]![1]!;
    const rem = chain.slice(cp.length);
    if (rem.length) parts.push(...rem);
    for (const [s, e] of seglist) {
      for (let i = s; i <= e; i += 1) parts.push(`${' '.repeat(lines[i]!.indent)}- ${lines[i]!.text}`);
      parts.push('');
    }
  }
  return parts.join('\n').replace(/\n+$/, '');
}

function chunkChars(lines: Line[], segs: Array<[number, number]>): number {
  return buildChunkTextGrouped(lines, segs).length;
}

export function chunkSnapshotText(snapshot: string, maxSize: number, minSize: number): string[] {
  const lines = parseLines(snapshot);
  if (!lines.length) return [];
  const maxDepth = Math.max(...lines.map((l) => l.depth));

  const initial = splitByDepth(lines, 0, lines.length - 1, 0);
  let chunks: Array<Array<[number, number]>> = initial.map((seg) => [seg]);
  let currentDepth = 1;
  while (true) {
    let changed = false;
    const next: Array<Array<[number, number]>> = [];
    for (const segs of chunks) {
      if (chunkChars(lines, segs) <= maxSize || currentDepth > maxDepth) {
        next.push(segs);
        continue;
      }
      for (const [s, e] of segs) {
        const subs = splitByDepth(lines, s, e, currentDepth);
        if (subs.length === 1) {
          next.push([subs[0]!]);
        } else {
          changed = true;
          for (const sub of subs) next.push([sub]);
        }
      }
    }
    chunks = next;
    if (!changed) {
      if (chunks.every((segs) => chunkChars(lines, segs) <= maxSize)) break;
    }
    currentDepth += 1;
    if (currentDepth > maxDepth) break;
  }

  let i = 0;
  while (i < chunks.length) {
    const size = chunkChars(lines, chunks[i]!);
    if (size < minSize) {
      if (i + 1 < chunks.length) {
        chunks[i] = chunks[i]!.concat(chunks[i + 1]!);
        chunks.splice(i + 1, 1);
        continue;
      } else if (i - 1 >= 0) {
        chunks[i - 1] = chunks[i - 1]!.concat(chunks[i]!);
        chunks.splice(i, 1);
        i -= 1;
        continue;
      }
    }
    i += 1;
  }

  return chunks.map((segs) => buildChunkTextGrouped(lines, segs));
}

function getRerankRegion(): string {
  const raw = String(process.env.AGENT_BEDROCK_RERANK_REGION || '').trim();
  if (raw) {
    const first = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)[0];
    if (first) return first;
  }
  return 'us-west-2';
}

function getRerankModelArn(region: string): string {
  const envArn = String(process.env.AGENT_BEDROCK_RERANK_MODEL_ARN || '').trim();
  if (envArn) return envArn;
  return `arn:aws:bedrock:${region}::foundation-model/cohere.rerank-v3-5:0`;
}

function toIntEnv(key: string, dflt: number): number {
  const v = Math.trunc(Number(process.env[key]));
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export function getDefaultTopK(category: 'browser' | 'search', fallback: number): number {
  if (category === 'browser') return toIntEnv('AGENT_BROWSER_TOP_K', fallback);
  return toIntEnv('AGENT_SEARCH_TOP_K', fallback);
}

export type RerankOptions = { topK?: number; category?: 'browser' | 'search'; name?: string };

export async function rerankPlainTextDocuments(query: string, docs: string[], options?: RerankOptions): Promise<Array<{ index: number; score: number }>> {
  const q = String(query || '').trim();
  const list = Array.isArray(docs) ? docs : [];
  if (!q || !list.length) return [];
  const region = getRerankRegion();
  const modelArn = getRerankModelArn(region);
  const client = new BedrockAgentRuntimeClient({ region });
  const MAX_DOC_LEN = 32000;
  const sources = list.slice(0, 1000).map((t) => ({
    type: 'INLINE' as const,
    inlineDocumentSource: { type: 'TEXT' as const, textDocument: { text: String(t ?? '').slice(0, MAX_DOC_LEN) } },
  }));
  const defaultK = getDefaultTopK(options?.category || 'search', 5);
  const k = Math.max(0, Math.min(options?.topK ?? defaultK, sources.length));
  if (k === 0) return [];
  const cmd = new RerankCommand({
    queries: [{ type: 'TEXT', textQuery: { text: q } }],
    sources,
    rerankingConfiguration: { type: 'BEDROCK_RERANKING_MODEL', bedrockRerankingConfiguration: { numberOfResults: k, modelConfiguration: { modelArn } } },
  } as any);
  const handle = recordRerankCallStart({ modelArn, region, input: { query: q, sourcesPreviewCount: sources.length, numberOfResults: k }, name: options?.name || 'Text Rerank' });
  try { recordRerankUsage(handle, sources.length); } catch {}
  try {
    const res = await client.send(cmd);
    const results = ((res as any)?.results ?? []).slice(0, k) as Array<{ index: number; relevanceScore: number }>;
    recordRerankCallSuccess(handle, { response: res, resultsSummary: results.map((r, i) => ({ i, index: r.index, score: r.relevanceScore })) });
    return results.map((r) => ({ index: r.index, score: r.relevanceScore }));
  } catch (e: any) {
    recordRerankCallError(handle, e, { modelArn, region, numberOfResults: k, name: options?.name || 'Text Rerank' });
    return [];
  }
}

export async function rerankSnapshotTopChunks(snapshotText: string, query: string, topOrOptions?: number | RerankOptions): Promise<Array<{ score: number; text: string }>> {
  const q = String(query || '').trim();
  if (!snapshotText || !q) return [];
  const envMax = String(process.env.AGENT_SNAPSHOT_MAX_CHUNK_SIZE || '').trim();
  const envMin = String(process.env.AGENT_SNAPSHOT_MIN_CHUNK_SIZE || '').trim();
  const maxChunkSize = Number.isFinite(Number(envMax)) ? Math.max(100, Math.trunc(Number(envMax))) : 5500;
  const minChunkSize = Number.isFinite(Number(envMin)) ? Math.max(50, Math.trunc(Number(envMin))) : 500;

  const chunks = chunkSnapshotText(snapshotText, maxChunkSize, minChunkSize);
  if (!chunks.length) return [];
  const region = getRerankRegion();
  const modelArn = getRerankModelArn(region);
  const client = new BedrockAgentRuntimeClient({ region });
  const MAX_DOC_LEN = 32000;
  const sources = chunks.slice(0, 1000).map((text) => ({
    type: 'INLINE' as const,
    inlineDocumentSource: { type: 'TEXT' as const, textDocument: { text: String(text ?? '').slice(0, MAX_DOC_LEN) } },
  }));
  let explicitTopK: number | undefined = undefined;
  let options: RerankOptions | undefined = undefined;
  if (typeof topOrOptions === 'number') explicitTopK = topOrOptions;
  else options = topOrOptions;
  const defaultK = getDefaultTopK(options?.category || 'browser', 3);
  const k = Math.max(0, Math.min(explicitTopK ?? options?.topK ?? defaultK, sources.length));
  if (k === 0) return [];
  const cmd = new RerankCommand({
    queries: [{ type: 'TEXT', textQuery: { text: q } }],
    sources,
    rerankingConfiguration: {
      type: 'BEDROCK_RERANKING_MODEL',
      bedrockRerankingConfiguration: { numberOfResults: k, modelConfiguration: { modelArn } },
    },
  } as any);
  const handle = recordRerankCallStart({ modelArn, region, input: { query: q, sourcesPreviewCount: sources.length, numberOfResults: k }, name: options?.name || 'Snapshot Rerank (Live)' });
  try { recordRerankUsage(handle, sources.length); } catch {}
  try {
    const res = await client.send(cmd);
    const results = ((res as any)?.results ?? []).slice(0, k) as Array<{ index: number; relevanceScore: number }>;
    recordRerankCallSuccess(handle, { response: res, resultsSummary: results.map((r, i) => ({ i, index: r.index, score: r.relevanceScore })) });
    const top = results.map((r) => ({ score: r.relevanceScore, text: chunks[r.index] ?? '' })).filter((x) => x.text);
    return top;
  } catch (e: any) {
    recordRerankCallError(handle, e, { modelArn, region, numberOfResults: k, name: options?.name || 'Snapshot Rerank (Live)' });
    return [];
  }
}




