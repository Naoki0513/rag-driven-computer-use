import { ensureSharedBrowserStarted, takeSnapshots, formatToolError, clickWithFallback } from './util.js';
import { createDriver, closeDriver } from '../../utilities/neo4j.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import type { Driver } from 'neo4j-driver';
import { browserLogin } from './browser-login.js';
import { getTimeoutMs } from '../../utilities/timeout.js';
// ref フォールバックは削除したため snapshots 直接取得は不要

type ClickStep = { ref?: string; role?: string; name?: string; href?: string };

export async function browserGoto(targetId: number): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();
  const t = getTimeoutMs('agent');

  const uri = process.env.AGENT_NEO4J_URI;
  const user = process.env.AGENT_NEO4J_USER;
  const password = process.env.AGENT_NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    return JSON.stringify({ action: 'goto', performed: [{ stage: 'init', ok: 'エラー: Neo4j接続情報が未設定です (AGENT_NEO4J_*)' }] });
  }

  let driver: Driver | null = null;
  try {
    driver = await createDriver(uri, user, password);
    const session = driver.session();
    try {
      const performed: Array<{ stage: string; selector?: any; ok: boolean | string }> = [];
      let shouldStop = false;
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
        return JSON.stringify({ action: 'goto', targetId, performed: [{ stage: 'plan', ok: `エラー: CLICK_TO 経路が見つかりませんでした targetId=${targetId}` }] });
      }

      const navigateUrl: string = rec.get('navigateUrl');
      const clickSteps: ClickStep[] = rec.get('clickSteps') ?? [];

      // NAVIGATE_TO のURLへ遷移
      try {
        await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: t });
        performed.push({ stage: 'navigate', ok: true });
      } catch (e: any) {
        const note = formatToolError(e);
        performed.push({ stage: 'navigate', ok: note });
        const snaps = await takeSnapshots(page).catch(() => null as any);
        const payload: any = { action: 'goto', targetId, navigateUrl, performed };
        if (snaps) {
          const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
          payload.snapshots = { text: snaps.text, id: snapshotId };
        }
        return JSON.stringify(payload);
      }

      // 遷移直後に LoginPage ラベルのページであれば、自動ログインを一度だけ挿入
      try {
        const preSnaps = await takeSnapshots(page);
        const currentId = await findPageIdByHashOrUrl(preSnaps.hash, preSnaps.url);
        if (currentId !== null) {
          const checkRes = await session.run(
            'MATCH (n:Page) WHERE id(n) = $id RETURN n:LoginPage AS isLogin LIMIT 1',
            { id: Number(currentId) },
          );
          const rec0 = checkRes.records?.[0];
          const isLogin = !!(rec0 && (rec0.get('isLogin') === true || rec0.get('isLogin') === 1));
          if (isLogin) {
            try {
              await browserLogin(preSnaps.url);
              try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
            } catch {}
          }
        }
      } catch {}

      // 経路に沿ってクリック。role+name/href を優先し、ref は原則使用しない（互換のため最後の最後に試行）
      for (const step of clickSteps) {
        if (shouldStop) {
          performed.push({ stage: 'click', selector: step, ok: 'エラー: 前段の失敗によりスキップしました' });
          continue;
        }
        const ref = String(step?.ref ?? '').trim();
        const role = String(step?.role ?? '').trim();
        const name = String(step?.name ?? '').trim();
        const href = String(step?.href ?? '').trim();
        let clicked = false;
        const attemptErrors: string[] = [];
        // 1) role+name
        if (!clicked && role && name) {
          try {
            const locator = page.getByRole(role as any, { name, exact: true } as any);
            const el = locator.first();
            await el.waitFor({ state: 'visible', timeout: t });
            const isCheckbox = String(role || '').toLowerCase() === 'checkbox';
            await clickWithFallback(page, el, isCheckbox);
            clicked = true;
          } catch (e: any) { attemptErrors.push(String(e?.message ?? e)); }
        }
        // 2) href
        if (!clicked && href) {
          try {
            const link = page.locator(`a[href='${href}']`).first();
            await link.waitFor({ state: 'visible', timeout: t });
            await link.click();
            clicked = true;
          } catch (e: any) { attemptErrors.push(String(e?.message ?? e)); }
        }
        // ref フォールバックは廃止
        if (clicked) {
          await page.waitForLoadState('domcontentloaded', { timeout: t });
          performed.push({ stage: 'click', selector: { role, name, href, ref }, ok: true });
        } else {
          const note = formatToolError(attemptErrors.join(' | '));
          performed.push({ stage: 'click', selector: { role, name, href, ref }, ok: note });
          shouldStop = true;
        }
      }

      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({ action: 'goto', targetId, navigateUrl, clickSteps, performed, snapshots: { text: snaps.text, id: snapshotId } });
    } finally {
      await session.close();
    }
  } catch (e: any) {
    return JSON.stringify({ action: 'goto', targetId, performed: [{ stage: 'fatal', ok: formatToolError(e) }] });
  } finally {
    await closeDriver(driver);
  }
}




