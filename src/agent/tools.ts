import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Driver } from 'neo4j-driver';
import { createDriver, closeDriver } from '../utilities/neo4j.js';
import { getSnapshotForAI } from '../utilities/snapshots.js';
import { findRoleAndNameByRef } from '../utilities/text.js';

export async function runCypher(query: string): Promise<string> {
  const uri = process.env.AGENT_NEO4J_URI;
  const user = process.env.AGENT_NEO4J_USER;
  const password = process.env.AGENT_NEO4J_PASSWORD;
  if (!uri || !user || !password) return 'エラー: Neo4j接続情報(AGENT_NEO4J_URI/AGENT_NEO4J_USER/AGENT_NEO4J_PASSWORD)が未設定です';

  let driver: Driver | null = null;
  try {
    driver = await createDriver(uri, user, password);
    const session = driver.session();
    try {
      const res = await session.run(query);
      const records = res.records.map((r) => r.toObject());
      if (!records.length) return '結果: データが見つかりませんでした';
      const lines: string[] = [];
      records.slice(0, 20).forEach((rec, i) => lines.push(`レコード ${i + 1}: ${JSON.stringify(rec)}`));
      if (records.length > 20) lines.push(`\n... 他 ${records.length - 20} 件のレコードがあります`);
      return lines.join('\n');
    } finally {
      await session.close();
    }
  } catch (e: any) {
    return `クエリ実行エラー: ${String(e?.message ?? e)}`;
  } finally {
    await closeDriver(driver);
  }
}

// 共有ブラウザ管理（単一の Browser/Context/Page を使い回す）
let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;

async function performOptionalPreLogin(page: Page): Promise<void> {
  const domain = process.env.AGENT_BROWSER_DOMAIN;
  const username = process.env.AGENT_BROWSER_USERNAME;
  const password = process.env.AGENT_BROWSER_PASSWORD;
  if (!(domain && username && password)) return;
  try {
    console.log(`[Login] ${domain} にアクセスしてログインを試行します`);
    await page.goto(domain);
    await page.waitForLoadState('networkidle').catch(() => {});
    const loginInput = await page.$('input[name="emailOrUsername"]');
    if (loginInput) await loginInput.fill(username);
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) await pwInput.fill(password);
    const submit = await page.$('button.login');
    if (submit) await submit.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000).catch(() => {});
    console.log('Pre-login succeeded');
  } catch (e: any) {
    console.log(`Pre-login failed: ${String(e?.message ?? e)}`);
  }
}

export async function ensureSharedBrowserStarted(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (sharedBrowser && sharedContext && sharedPage) {
    return { browser: sharedBrowser, context: sharedContext, page: sharedPage };
  }
  const headful = String(process.env.AGENT_HEADFUL ?? 'false').toLowerCase() === 'true';
  sharedBrowser = await chromium.launch({ headless: !headful });
  sharedContext = await sharedBrowser.newContext();
  sharedPage = await sharedContext.newPage();
  await performOptionalPreLogin(sharedPage);
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
    }
  }
}

type WorkflowStep =
  | { action: 'goto'; url: string }
  | { action: 'click'; ref: string }
  | { action: 'input'; ref: string; text: string }
  | { action: 'press'; ref: string; key: string };

// 共通ヘルパー: ARIA/Text スナップショットの取得
async function takeSnapshots(page: Page): Promise<{ aria: any; text: string }> {
  const aria = await page.accessibility.snapshot().catch(() => ({}));
  const text = await getSnapshotForAI(page).catch(() => '');
  return { aria, text };
}

// 共通ヘルパー: ref(eXX) から Locator を解決
async function installRefSnapshotProvider(page: Page): Promise<void> {
  const makeSnapshot = async (): Promise<string> => {
    const tree: any = await page.accessibility.snapshot().catch(() => ({}));
    const lines: string[] = [];
    let counter = 1;
    const walk = (node: any, depth: number) => {
      if (!node || typeof node !== 'object') return;
      const role = String(node.role ?? 'generic');
      const name = typeof node.name === 'string' ? node.name : undefined;
      const ref = `e${counter++}`;
      const label = name && name.trim().length > 0 ? `${role} "${name}" [ref=${ref}]` : `${role} [ref=${ref}]`;
      lines.push(`${'  '.repeat(depth)}- ${label}`);
      const children: any[] = Array.isArray(node.children) ? node.children : [];
      for (const c of children) walk(c, depth + 1);
    };
    walk(tree, 0);
    return lines.join('\n');
  };
  (page as any)._snapshotForAI = makeSnapshot;
}

async function resolveLocatorByRef(page: Page, ref: string) {
  await installRefSnapshotProvider(page);
  const snapText = await getSnapshotForAI(page);
  const roleName = findRoleAndNameByRef(snapText, ref);
  if (!roleName) throw new Error(`ref=${ref} に対応する要素が見つかりません (現在のARIAスナップショット)`);
  const { role, name } = roleName;
  const locator = name && name.trim().length > 0
    ? page.getByRole(role as any, { name, exact: true } as any)
    : page.getByRole(role as any);
  await locator.first().waitFor({ state: 'visible', timeout: 30000 });
  return { locator, role, name } as const;
}

// 個別ツール: ブラウザ操作（goto/click/input/press）
export async function browserGoto(url: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  try {
    await page.goto(url);
    await page.waitForLoadState('networkidle').catch(() => {});
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: true, action: 'goto', url, snapshots: { aria: snaps.aria, text: snaps.text } });
  } catch (e: any) {
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: false, action: 'goto', url, error: String(e?.message ?? e), snapshots: { aria: snaps.aria, text: snaps.text } });
  }
}

export async function browserClick(ref: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  try {
    const { locator, role, name } = await resolveLocatorByRef(page, ref);
    await locator.first().click();
    await page.waitForLoadState('networkidle').catch(() => {});
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: true, action: 'click', ref, target: { role, name }, snapshots: { aria: snaps.aria, text: snaps.text } });
  } catch (e: any) {
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: false, action: 'click', ref, error: String(e?.message ?? e), snapshots: { aria: snaps.aria, text: snaps.text } });
  }
}

export async function browserInput(ref: string, text: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  try {
    const { locator, role, name } = await resolveLocatorByRef(page, ref);
    await locator.first().fill(text);
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: true, action: 'input', ref, text, target: { role, name }, snapshots: { aria: snaps.aria, text: snaps.text } });
  } catch (e: any) {
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: false, action: 'input', ref, text, error: String(e?.message ?? e), snapshots: { aria: snaps.aria, text: snaps.text } });
  }
}

export async function browserPress(ref: string, key: string): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  try {
    const { locator, role, name } = await resolveLocatorByRef(page, ref);
    await locator.first().press(key);
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: true, action: 'press', ref, key, target: { role, name }, snapshots: { aria: snaps.aria, text: snaps.text } });
  } catch (e: any) {
    const snaps = await takeSnapshots(page);
    return JSON.stringify({ success: false, action: 'press', ref, key, error: String(e?.message ?? e), snapshots: { aria: snaps.aria, text: snaps.text } });
  }
}

export async function executeWorkflow(workflow: WorkflowStep[]): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  const results: string[] = [];
  const snapshots: string[] = [];
  try {
    // 互換: 旧ワークフロー実装は新ヘルパーを使用

    for (let i = 0; i < workflow.length; i += 1) {
      const step = workflow[i]!;
      try {
        if (step.action === 'goto') {
          await page.goto(step.url);
          await page.waitForLoadState('networkidle').catch(() => {});
          results.push(`Navigated to ${step.url}`);
        } else if (step.action === 'click') {
          const { locator, role, name } = await resolveLocatorByRef(page, step.ref);
          await locator.first().click();
          await page.waitForLoadState('networkidle').catch(() => {});
          results.push(`Clicked ref=${step.ref} (${role}${name ? `: ${name}` : ''})`);
        } else if (step.action === 'input') {
          const { locator, role, name } = await resolveLocatorByRef(page, step.ref);
          await locator.first().fill(step.text);
          results.push(`Input into ref=${step.ref} (${role}${name ? `: ${name}` : ''}) -> ${step.text}`);
        } else if (step.action === 'press') {
          const { locator, role, name } = await resolveLocatorByRef(page, step.ref);
          await locator.first().press(step.key);
          results.push(`Pressed ${step.key} on ref=${step.ref} (${role}${name ? `: ${name}` : ''})`);
        } else {
          results.push(`Unknown action: ${(step as any).action}`);
        }
      } catch (e: any) {
        const snap = await page.accessibility.snapshot().catch(() => ({}));
        const textSnap = await getSnapshotForAI(page).catch(() => '');
        results.push(`Error in step ${i + 1}: ${String(e?.message ?? e)}\nError ARIA Snapshot: ${JSON.stringify(snap)}`);
        snapshots.push(`Error ARIA Snapshot for step ${i + 1}: ${JSON.stringify(snap)}`);
        if (textSnap) snapshots.push(`Error Text Snapshot with refs for step ${i + 1}:\n${textSnap}`);
        break;
      }
      const snap = await page.accessibility.snapshot().catch(() => ({}));
      const textSnap = await getSnapshotForAI(page).catch(() => '');
      snapshots.push(`ARIA Snapshot after step ${i + 1}: ${JSON.stringify(snap)}`);
      if (textSnap) snapshots.push(`Text Snapshot with refs after step ${i + 1}:\n${textSnap}`);
    }
    const finalSnap = await page.accessibility.snapshot().catch(() => ({}));
    const finalTextSnap = await getSnapshotForAI(page).catch(() => '');
    snapshots.push(`Final ARIA Snapshot: ${JSON.stringify(finalSnap)}`);
    if (finalTextSnap) snapshots.push(`Final Text Snapshot with refs:\n${finalTextSnap}`);
  } finally {
    // 共有ブラウザはここでは閉じない（上位で遅延クローズ）
  }
  return results.join('\n') + '\n\nSnapshots:\n' + snapshots.join('\n') + '\nWorkflow executed.';
}

export type ToolUseInput =
  | { name: 'run_cypher'; input: { query: string }; toolUseId: string }
  | { name: 'browser_goto'; input: { url: string }; toolUseId: string }
  | { name: 'browser_click'; input: { ref: string }; toolUseId: string }
  | { name: 'browser_input'; input: { ref: string; text: string }; toolUseId: string }
  | { name: 'browser_press'; input: { ref: string; key: string }; toolUseId: string };


