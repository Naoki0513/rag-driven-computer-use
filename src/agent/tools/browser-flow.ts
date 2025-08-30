import { ensureSharedBrowserStarted, takeSnapshots } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import { getSnapshotForAI } from '../../utilities/snapshots.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';

type FlowStep = {
  action: 'click' | 'input' | 'press';
  ref?: string;
  role?: string;
  name?: string;
  href?: string;
  text?: string; // for input
  key?: string;  // for press
};

type BrowserFlowInput = {
  steps: FlowStep[];
};

export async function browserFlow(input: BrowserFlowInput): Promise<string> {
  const { page } = await ensureSharedBrowserStarted();

  const steps: FlowStep[] = Array.isArray(input?.steps) ? input.steps : [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return JSON.stringify({ success: false, error: 'steps が空です' });
  }

  try {
      // 0) フロー開始前のスナップショットを1回だけ取得し、全 ref を事前解決
      const initialSnapshotText = await getSnapshotForAI(page);
      const preResolvedByRef = new Map<string, { role: string; name?: string }>();
      for (const s of steps) {
        const ref = String(s?.ref ?? '').trim();
        if (ref && !preResolvedByRef.has(ref)) {
          const rn = findRoleAndNameByRef(initialSnapshotText, ref);
          if (rn) preResolvedByRef.set(ref, rn);
        }
      }

      // 1) 画面操作ステップを順次実行（フォールバック: preResolved(ref) → role+name → href(clickのみ)）
      const performed: Array<{ action: string; selector: any; ok: boolean; note?: string }> = [];

      for (const s of steps) {
        const action = String(s?.action ?? '').trim() as FlowStep['action'];
        const ref = String(s?.ref ?? '').trim();
        const role = String(s?.role ?? '').trim();
        const name = String(s?.name ?? '').trim();
        const href = String(s?.href ?? '').trim();
        const text = String(s?.text ?? '');
        const key = String(s?.key ?? '');

        let ok = false;
        let note: string | undefined = undefined;
        try {
          if (action === 'input') {
            let resolved = false;
            if (!resolved && ref) {
              try {
                const rn = preResolvedByRef.get(ref);
                if (rn) {
                  const loc = rn.name
                    ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
                    : page.getByRole(rn.role as any);
                  await loc.first().waitFor({ state: 'visible', timeout: 30000 });
                  await loc.first().fill(text);
                  resolved = true;
                }
              } catch {}
            }
            if (!resolved && role) {
              try {
                const locator = name
                  ? page.getByRole(role as any, { name, exact: true } as any)
                  : page.getByRole(role as any);
                await locator.first().waitFor({ state: 'visible', timeout: 30000 });
                await locator.first().fill(text);
                resolved = true;
              } catch {}
            }
            ok = resolved;
          } else if (action === 'click') {
            let resolved = false;
            if (!resolved && ref) {
              try {
                const rn = preResolvedByRef.get(ref);
                if (rn) {
                  const loc = rn.name
                    ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
                    : page.getByRole(rn.role as any);
                  await loc.first().waitFor({ state: 'visible', timeout: 30000 });
                  await loc.first().click();
                  resolved = true;
                }
              } catch {}
            }
            if (!resolved && role) {
              try {
                const locator = name
                  ? page.getByRole(role as any, { name, exact: true } as any)
                  : page.getByRole(role as any);
                await locator.first().waitFor({ state: 'visible', timeout: 30000 });
                await locator.first().click();
                resolved = true;
              } catch {}
            }
            if (!resolved && href) {
              try {
                const link = page.locator(`a[href='${href}']`).first();
                await link.waitFor({ state: 'visible', timeout: 15000 });
                await link.click();
                resolved = true;
              } catch {}
            }
            ok = resolved;
            if (ok) {
              try { await page.waitForLoadState('domcontentloaded', { timeout: 45000 }); } catch {}
            }
          } else if (action === 'press') {
            if (ref || role) {
              let resolved = false;
              if (!resolved && ref) {
                try {
                  const rn = preResolvedByRef.get(ref);
                  if (rn) {
                    const loc = rn.name
                      ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
                      : page.getByRole(rn.role as any);
                    await loc.first().waitFor({ state: 'visible', timeout: 30000 });
                    await loc.first().press(key || 'Enter');
                    resolved = true;
                  }
                } catch {}
              }
              if (!resolved && role) {
                try {
                  const locator = name
                    ? page.getByRole(role as any, { name, exact: true } as any)
                    : page.getByRole(role as any);
                await locator.first().waitFor({ state: 'visible', timeout: 30000 });
                await locator.first().press(key || 'Enter');
                resolved = true;
                } catch {}
              }
              ok = resolved;
            } else {
              // セレクタ指定なしの場合はグローバルに送る
              await page.keyboard.press(key || 'Enter');
              ok = true;
            }
            if (ok) {
              try { await page.waitForLoadState('domcontentloaded', { timeout: 45000 }); } catch {}
            }
          } else {
            note = `未知の action=${action}`;
          }
        } catch (e: any) {
          note = String(e?.message ?? e);
        }
        const entry: { action: string; selector: any; ok: boolean; note?: string } = {
          action,
          selector: { ref, role, name, href },
          ok,
        };
        if (note !== undefined) entry.note = note;
        performed.push(entry);
      }

      const snaps = await takeSnapshots(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      return JSON.stringify({
        success: true,
        action: 'browser_flow',
        selected: {},
        navigation: {},
        performed,
        snapshots: { text: snaps.text, id: snapshotId },
      });
  } catch (e: any) {
    return JSON.stringify({ success: false, error: String(e?.message ?? e) });
  }
}


