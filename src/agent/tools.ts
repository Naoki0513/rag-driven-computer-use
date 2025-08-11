import { chromium } from 'playwright';
import type { Driver } from 'neo4j-driver';
import { createDriver, closeDriver } from '../crawler/database.js';

export async function runCypher(query: string): Promise<string> {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) return 'エラー: Neo4j接続情報(NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD)が未設定です';

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
  | { action: 'click'; role: string; name: string }
  | { action: 'input'; role: string; name: string; text: string }
  | { action: 'press'; role: string; name: string; key: string };

export async function executeWorkflow(workflow: WorkflowStep[]): Promise<string> {
  const headful = String(process.env.HEADFUL ?? 'false').toLowerCase() === 'true';
  const browser = await chromium.launch({ headless: !headful });
  const context = await browser.newContext();
  const page = await context.newPage();
  const results: string[] = [];
  const snapshots: string[] = [];
  try {
    for (let i = 0; i < workflow.length; i += 1) {
      const step = workflow[i]!;
      try {
        if (step.action === 'goto') {
          await page.goto(step.url);
          await page.waitForLoadState('networkidle').catch(() => {});
          results.push(`Navigated to ${step.url}`);
        } else if (step.action === 'click') {
          const locator = page.getByRole(step.role as any, { name: step.name, exact: true } as any);
          await locator.first().waitFor({ state: 'visible', timeout: 30000 });
          await locator.first().click();
          await page.waitForLoadState('networkidle').catch(() => {});
          results.push(`Clicked ${step.role}: ${step.name}`);
        } else if (step.action === 'input') {
          const locator = page.getByRole(step.role as any, { name: step.name, exact: true } as any);
          await locator.first().waitFor({ state: 'visible', timeout: 30000 });
          await locator.first().fill(step.text);
          results.push(`Input ${step.text} into ${step.role}: ${step.name}`);
        } else if (step.action === 'press') {
          const locator = page.getByRole(step.role as any, { name: step.name, exact: true } as any);
          await locator.first().waitFor({ state: 'visible', timeout: 30000 });
          await locator.first().press(step.key);
          results.push(`Pressed ${step.key} on ${step.role}: ${step.name}`);
        } else {
          results.push(`Unknown action: ${(step as any).action}`);
        }
      } catch (e: any) {
        const snap = await page.accessibility.snapshot().catch(() => ({}));
        results.push(`Error in step ${i + 1}: ${String(e?.message ?? e)}\nError ARIA Snapshot: ${JSON.stringify(snap)}`);
        snapshots.push(`Error ARIA Snapshot for step ${i + 1}: ${JSON.stringify(snap)}`);
        break;
      }
      const snap = await page.accessibility.snapshot().catch(() => ({}));
      snapshots.push(`ARIA Snapshot after step ${i + 1}: ${JSON.stringify(snap)}`);
    }
    const finalSnap = await page.accessibility.snapshot().catch(() => ({}));
    snapshots.push(`Final ARIA Snapshot: ${JSON.stringify(finalSnap)}`);
  } finally {
    await browser.close();
  }
  return results.join('\n') + '\n\nSnapshots:\n' + snapshots.join('\n') + '\nWorkflow executed.';
}

export type ToolUseInput =
  | { name: 'run_cypher'; input: { query: string }; toolUseId: string }
  | { name: 'execute_workflow'; input: { workflow: WorkflowStep[] }; toolUseId: string };


