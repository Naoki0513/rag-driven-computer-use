import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';
import { createDriver, closeDriver } from '../../utilities/neo4j.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import type { Driver } from 'neo4j-driver';

type ClickStep = { ref?: string; role?: string; name?: string; href?: string };

export async function browserGoto(targetId: number): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();

  const uri = process.env.AGENT_NEO4J_URI;
  const user = process.env.AGENT_NEO4J_USER;
  const password = process.env.AGENT_NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    return JSON.stringify({ success: false, error: 'Neo4j接続情報が未設定です (AGENT_NEO4J_*)' });
  }

  let driver: Driver | null = null;
  try {
    driver = await createDriver(uri, user, password);
    const session = driver.session();
    try {
      // 1) NAVIGATE_TO 起点から CLICK_TO*1..200 のパスを取得（非最短、長さ順）
      const q1 = `
WITH $targetId AS targetId
MATCH (t:Page) WHERE id(t) = targetId
MATCH (anyStart:Page)-[nav:NAVIGATE_TO]->(m:Page)
MATCH p = (m)-[:CLICK_TO*0..200]->(t)
RETURN m.url AS landingUrl,
       nav.url AS navigateUrl,
       [r IN relationships(p) | { ref: coalesce(r.ref,''), role: r.role, name: r.name, href: r.href }] AS clickSteps,
       length(p) AS clicks
ORDER BY clicks ASC
LIMIT 1`;
      let rec = (await session.run(q1, { targetId: Number(targetId) })).records?.[0];

      // 2) NAVIGATE_TO からは繋がらない場合、任意の m から CLICK_TO*1..200
      if (!rec) {
        const q2 = `
WITH $targetId AS targetId
MATCH (t:Page) WHERE id(t) = targetId
MATCH (m:Page)
MATCH p = (m)-[:CLICK_TO*1..200]->(t)
RETURN m.url AS landingUrl,
       m.url AS navigateUrl,
       [r IN relationships(p) | { ref: coalesce(r.ref,''), role: r.role, name: r.name, href: r.href }] AS clickSteps,
       length(p) AS clicks
ORDER BY clicks ASC
LIMIT 1`;
        rec = (await session.run(q2, { targetId: Number(targetId) })).records?.[0];
      }

      if (!rec) {
        return JSON.stringify({ success: false, error: `CLICK_TO 経路が見つかりませんでした targetId=${targetId}` });
      }

      const navigateUrl: string = rec.get('navigateUrl');
      const clickSteps: ClickStep[] = rec.get('clickSteps') ?? [];

      // NAVIGATE_TO のURLへ遷移
      await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // 経路に沿ってクリック。ref/role+name/href の順で解決を試みる
      for (const step of clickSteps) {
        const ref = String(step?.ref ?? '').trim();
        const role = String(step?.role ?? '').trim();
        const name = String(step?.name ?? '').trim();
        const href = String(step?.href ?? '').trim();
        let clicked = false;
        // 1) ref 優先
        if (!clicked && ref) {
          try {
            const { locator } = await resolveLocatorByRef(page, ref);
            await locator.first().click();
            clicked = true;
          } catch {}
        }
        // 2) role+name
        if (!clicked && role && name) {
          try {
            const locator = page.getByRole(role as any, { name, exact: true } as any);
            await locator.first().waitFor({ state: 'visible', timeout: 15000 });
            await locator.first().click();
            clicked = true;
          } catch {}
        }
        // 3) href
        if (!clicked && href) {
          try {
            const link = page.locator(`a[href='${href}']`).first();
            await link.waitFor({ state: 'visible', timeout: 15000 });
            await link.click();
            clicked = true;
          } catch {}
        }
        if (clicked) {
          await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
        }
      }

      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({ success: true, action: 'goto', targetId, navigateUrl, clickSteps, snapshots: { text: snaps.text, id: snapshotId } });
    } finally {
      await session.close();
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, error: String(e?.message ?? e) });
  } finally {
    await closeDriver(driver);
  }
}




