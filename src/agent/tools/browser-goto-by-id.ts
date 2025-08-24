import { ensureSharedBrowserStarted, takeSnapshots, resolveLocatorByRef } from './util.js';
import { createDriver, closeDriver } from '../../utilities/neo4j.js';
import type { Driver } from 'neo4j-driver';

type ClickStep = { ref?: string; role?: string; name?: string; href?: string };

export async function browserGotoById(targetId: number): Promise<string> {
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
      const cypher = `
MATCH (t:Page)
WHERE id(t) = $targetId
MATCH (anyStart:Page)-[nav:NAVIGATE_TO]->(m:Page)
CALL {
  WITH m, t
  MATCH p = shortestPath((m)-[:CLICK_TO*0..25]->(t))
  RETURN p
}
RETURN m.url AS landingUrl,
       nav.url AS navigateUrl,
       [r IN relationships(p) | { ref: r.ref, role: r.role, name: r.name, href: r.href }] AS clickSteps,
       length(p) AS clicks
ORDER BY clicks ASC
LIMIT 1`;
      const res = await session.run(cypher, { targetId: Number(targetId) });
      if (!res.records || res.records.length === 0) {
        return JSON.stringify({ success: false, error: `経路が見つかりませんでした targetId=${targetId}` });
      }
      const rec = res.records[0]!;
      const navigateUrl: string = rec.get('navigateUrl');
      const clickSteps: ClickStep[] = rec.get('clickSteps') ?? [];

      // まず NAVIGATE_TO のURLへ遷移（networkidle は安定しない場合があるため domcontentloaded に変更）
      await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // CLICK_TO の最短経路に沿ってクリック実行
      for (const step of clickSteps) {
        const ref = String(step?.ref ?? '').trim();
        if (!ref) continue;
        const { locator } = await resolveLocatorByRef(page, ref);
        await locator.first().click();
        await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
      }

      const snaps = await takeSnapshots(page);
      return JSON.stringify({
        success: true,
        action: 'goto_by_id',
        targetId,
        navigateUrl,
        clickSteps,
        snapshots: { text: snaps.text, hash: snaps.hash },
      });
    } finally {
      await session.close();
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, error: String(e?.message ?? e) });
  } finally {
    await closeDriver(driver);
  }
}


