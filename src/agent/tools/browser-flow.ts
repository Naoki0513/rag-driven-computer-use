import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, clickWithFallback, resolveLocatorByRef, attachTodos, getResolutionSnapshotText } from './util.js';
import { findPageIdByHashOrUrl } from '../../utilities/neo4j.js';
import { findRoleAndNameByRef } from '../../utilities/text.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

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
  const t = getTimeoutMs('agent');

  const steps: FlowStep[] = Array.isArray(input?.steps) ? input.steps : [];
  if (!Array.isArray(steps) || steps.length === 0) {
    const payload = await attachTodos({ action: 'browser_flow', performed: [], error: 'エラー: steps が空です' });
    return JSON.stringify(payload);
  }

  try {
      // 0) 事前解決は保持されている最新スナップショットから行う（操作前の取得はしない）
      const initialSnapshotText = getResolutionSnapshotText();
      const preResolvedByRef = new Map<string, { role: string; name?: string }>();
      for (const s of steps) {
        const ref = String(s?.ref ?? '').trim();
        if (ref && !preResolvedByRef.has(ref)) {
          const rn = initialSnapshotText ? findRoleAndNameByRef(initialSnapshotText, ref) : null;
          if (rn) preResolvedByRef.set(ref, rn);
        }
      }

      // 1) 画面操作ステップを順次実行（フォールバック: ref 直接解決 → preResolved(ref) → role+name → href(clickのみ)）
      const performed: Array<{ action: string; selector: any; ok: boolean | string }> = [];
      let shouldStop = false;

      for (const s of steps) {
        const action = String(s?.action ?? '').trim() as FlowStep['action'];
        const ref = String(s?.ref ?? '').trim();
        const role = String(s?.role ?? '').trim();
        const name = String(s?.name ?? '').trim();
        const href = String(s?.href ?? '').trim();
        const text = String(s?.text ?? '');
        const key = String(s?.key ?? '');

        if (shouldStop) {
          performed.push({ action, selector: { ref, role, name, href }, ok: 'エラー: 前段の失敗によりスキップしました' });
          continue;
        }

        let ok: boolean | string = false;
        let note: string | undefined = undefined;
        try {
          if (action === 'input') {
            let resolved = false;
            // 1) ref 直接解決（data-wg-ref / 索引 / 序数）
            if (!resolved && ref) {
              try {
                const _snapForResolve = getResolutionSnapshotText();
                const byRef = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
                if (byRef) {
                  await byRef.waitFor({ state: 'visible', timeout: t });
                  await byRef.fill(text);
                  resolved = true;
                }
              } catch (e: any) { note = formatToolError(e); }
            }
            if (!resolved && ref) {
              try {
                const rn = preResolvedByRef.get(ref);
                if (rn) {
                  const loc = rn.name
                    ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
                    : page.getByRole(rn.role as any);
                  await loc.first().waitFor({ state: 'visible', timeout: t });
                  await loc.first().fill(text);
                  resolved = true;
                }
              } catch (e: any) { note = formatToolError(e); }
            }
            if (!resolved && role) {
              try {
                const locator = name
                  ? page.getByRole(role as any, { name, exact: true } as any)
                  : page.getByRole(role as any);
                await locator.first().waitFor({ state: 'visible', timeout: t });
                await locator.first().fill(text);
                resolved = true;
              } catch (e: any) { note = formatToolError(e); }
            }
            ok = resolved ? true : (note || 'エラー: 入力に失敗しました');
          } else if (action === 'click') {
            let resolved = false;
            // 1) ref 直接解決
            if (!resolved && ref) {
              try {
                const _snapForResolve = getResolutionSnapshotText();
                const byRef = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
                if (byRef) {
                  const el = byRef;
                  await el.waitFor({ state: 'visible', timeout: t });
                  // 役割が不明でも checkbox 判定を試行
                  let isCheckbox = false;
                  try { const r = await el.getAttribute('role'); isCheckbox = String(r||'').toLowerCase() === 'checkbox'; } catch {}
                  await clickWithFallback(page, el, isCheckbox);
                  resolved = true;
                }
              } catch (e: any) { note = formatToolError(e); }
            }
            if (!resolved && ref) {
              try {
                const rn = preResolvedByRef.get(ref);
                if (rn) {
                  const loc = rn.name
                    ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
                    : page.getByRole(rn.role as any);
                  const el = loc.first();
                  await el.waitFor({ state: 'visible', timeout: t });
                  const isCheckbox = String(rn.role || '').toLowerCase() === 'checkbox';
                  await clickWithFallback(page, el, isCheckbox);
                  resolved = true;
                }
              } catch (e: any) { note = formatToolError(e); }
            }
            if (!resolved && role) {
              try {
                const locator = name
                  ? page.getByRole(role as any, { name, exact: true } as any)
                  : page.getByRole(role as any);
                const el = locator.first();
                await el.waitFor({ state: 'visible', timeout: t });
                const isCheckbox = String(role || '').toLowerCase() === 'checkbox';
                await clickWithFallback(page, el, isCheckbox);
                resolved = true;
              } catch (e: any) { note = formatToolError(e); }
            }
            if (!resolved && href) {
              try {
                const link = page.locator(`a[href='${href}']`).first();
                await link.waitFor({ state: 'visible', timeout: t });
                await link.click();
                resolved = true;
              } catch (e: any) { note = formatToolError(e); }
            }
            ok = resolved ? true : (note || 'エラー: クリックに失敗しました');
            if (ok === true) {
              try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
            }
          } else if (action === 'press') {
            if (ref || role) {
              let resolved = false;
              // 1) ref 直接解決
              if (!resolved && ref) {
                try {
                  const _snapForResolve = getResolutionSnapshotText();
                  const byRef = await resolveLocatorByRef(page, ref, _snapForResolve ? { resolutionSnapshotText: _snapForResolve } : undefined);
                  if (byRef) {
                    await byRef.waitFor({ state: 'visible', timeout: t });
                    await byRef.press(key || 'Enter');
                    resolved = true;
                  }
                } catch (e: any) { note = formatToolError(e); }
              }
              if (!resolved && ref) {
                try {
                  const rn = preResolvedByRef.get(ref);
                  if (rn) {
                    const loc = rn.name
                      ? page.getByRole(rn.role as any, { name: rn.name, exact: true } as any)
                      : page.getByRole(rn.role as any);
                    await loc.first().waitFor({ state: 'visible', timeout: t });
                    await loc.first().press(key || 'Enter');
                    resolved = true;
                  }
                } catch (e: any) { note = formatToolError(e); }
              }
              if (!resolved && role) {
                try {
                  const locator = name
                    ? page.getByRole(role as any, { name, exact: true } as any)
                    : page.getByRole(role as any);
                await locator.first().waitFor({ state: 'visible', timeout: t });
                await locator.first().press(key || 'Enter');
                resolved = true;
                } catch (e: any) { note = formatToolError(e); }
              }
              ok = resolved ? true : (note || 'エラー: キー送信に失敗しました');
            } else {
              // セレクタ指定なしの場合はグローバルに送る
              try {
                await page.keyboard.press(key || 'Enter');
                ok = true;
              } catch (e: any) {
                ok = formatToolError(e);
              }
            }
            if (ok === true) {
              try { await page.waitForLoadState('domcontentloaded', { timeout: t }); } catch {}
            }
          } else {
            ok = `エラー: 未知の action=${action}`;
          }
        } catch (e: any) {
          ok = formatToolError(e);
        }
        performed.push({ action, selector: { ref, role, name, href }, ok });
        if (ok !== true) {
          shouldStop = true;
        }
      }

      const snaps = await captureAndStoreSnapshot(page);
      const snapshotId = await findPageIdByHashOrUrl(snaps.hash, snaps.url);
      const payload = await attachTodos({
        action: 'browser_flow',
        selected: {},
        navigation: {},
        performed,
        snapshots: { text: snaps.text, id: snapshotId },
      });
      return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ action: 'browser_flow', performed: [], error: formatToolError(e) });
    return JSON.stringify(payload);
  }
}


