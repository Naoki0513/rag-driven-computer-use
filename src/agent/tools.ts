import { chromium } from 'playwright';
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

type WorkflowStep =
  | { action: 'goto'; url: string }
  | { action: 'click'; ref: string }
  | { action: 'input'; ref: string; text: string }
  | { action: 'press'; ref: string; key: string };

export async function executeWorkflow(workflow: WorkflowStep[]): Promise<string> {
  const headful = String(process.env.AGENT_HEADFUL ?? 'false').toLowerCase() === 'true';
  const browser = await chromium.launch({ headless: !headful });
  const context = await browser.newContext();
  const page = await context.newPage();
  const results: string[] = [];
  const snapshots: string[] = [];
  try {
    // Optional pre-login flow to align with Python implementation
    const domain = process.env.AGENT_BROWSER_DOMAIN;
    const username = process.env.AGENT_BROWSER_USERNAME;
    const password = process.env.AGENT_BROWSER_PASSWORD;
    if (domain && username && password) {
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
        results.push('Pre-login succeeded');
      } catch (e: any) {
        results.push(`Pre-login failed: ${String(e?.message ?? e)}`);
      }
    }

    // 提供: 現ページのARIAスナップショットに [ref=eXX] を付与する関数を注入
    async function installRefSnapshotProvider() {
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

    async function resolveLocatorByRef(ref: string) {
      // 必ずプロバイダをセットしてから参照解決
      await installRefSnapshotProvider();
      const snapText = await getSnapshotForAI(page);
      const roleName = findRoleAndNameByRef(snapText, ref);
      if (!roleName) throw new Error(`ref=${ref} に対応する要素が見つかりません (現在のARIAスナップショット)`);
      const { role, name } = roleName;
      const locator = name && name.trim().length > 0
        ? page.getByRole(role as any, { name, exact: true } as any)
        : page.getByRole(role as any);
      // 要素の存在確認
      await locator.first().waitFor({ state: 'visible', timeout: 30000 });
      return { locator, role, name } as const;
    }

    for (let i = 0; i < workflow.length; i += 1) {
      const step = workflow[i]!;
      try {
        if (step.action === 'goto') {
          await page.goto(step.url);
          await page.waitForLoadState('networkidle').catch(() => {});
          results.push(`Navigated to ${step.url}`);
        } else if (step.action === 'click') {
          const { locator, role, name } = await resolveLocatorByRef(step.ref);
          await locator.first().click();
          await page.waitForLoadState('networkidle').catch(() => {});
          results.push(`Clicked ref=${step.ref} (${role}${name ? `: ${name}` : ''})`);
        } else if (step.action === 'input') {
          const { locator, role, name } = await resolveLocatorByRef(step.ref);
          await locator.first().fill(step.text);
          results.push(`Input into ref=${step.ref} (${role}${name ? `: ${name}` : ''}) -> ${step.text}`);
        } else if (step.action === 'press') {
          const { locator, role, name } = await resolveLocatorByRef(step.ref);
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
    await browser.close();
  }
  return results.join('\n') + '\n\nSnapshots:\n' + snapshots.join('\n') + '\nWorkflow executed.';
}

export type ToolUseInput =
  | { name: 'run_cypher'; input: { query: string }; toolUseId: string }
  | { name: 'execute_workflow'; input: { workflow: WorkflowStep[] }; toolUseId: string };


