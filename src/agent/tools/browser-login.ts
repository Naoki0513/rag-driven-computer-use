import { ensureSharedBrowserStarted, takeSnapshots } from './util.js';

export async function browserLogin(url: string): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    const username = String(process.env.AGENT_BROWSER_USERNAME ?? '').trim();
    const password = String(process.env.AGENT_BROWSER_PASSWORD ?? '').trim();
    if (!username || !password) {
      return JSON.stringify({ success: false, action: 'login', url, error: 'AGENT_BROWSER_USERNAME/AGENT_BROWSER_PASSWORD が未設定です' });
    }

    try {
      if (url && url.trim().length > 0) {
        await page.goto(url);
        await page.waitForLoadState('networkidle');
      }

      const userSelectors = [
        'input[name="emailOrUsername"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[name="user"]',
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[id*="email" i]',
        'input[id*="user" i]',
        'input[placeholder*="メール" i]',
        'input[placeholder*="email" i]',
        'input[placeholder*="ユーザー" i]',
        'input[placeholder*="username" i]'
      ];
      let filledUser = false;
      for (const sel of userSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill(username);
          filledUser = true;
          break;
        }
      }
      if (!filledUser) throw new Error('ユーザー名入力欄が見つかりません');

      const passSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[autocomplete="current-password"]',
        'input[id*="pass" i]',
        'input[placeholder*="パスワード" i]',
        'input[placeholder*="password" i]'
      ];
      let pwEl: any = null;
      for (const sel of passSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill(password);
          pwEl = el;
          break;
        }
      }
      if (!pwEl) throw new Error('パスワード入力欄が見つかりません');

      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("ログイン")',
        'button:has-text("サインイン")',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'text=ログイン >> xpath=ancestor::button',
      ];
      let clicked = false;
      for (const sel of submitSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        await pwEl.press('Enter');
      }

      await page.waitForLoadState('networkidle');
      const snaps = await takeSnapshots(page);
      return JSON.stringify({ success: true, action: 'login', url, snapshots: { text: snaps.text, hash: snaps.hash } });
    } catch (e: any) {
      let snaps: { text: string; hash: string } | null = null;
      try { snaps = await takeSnapshots((await ensureSharedBrowserStarted()).page); } catch {}
      const payload: any = { success: false, action: 'login', url, error: String(e?.message ?? e) };
      if (snaps) payload.snapshots = { text: snaps.text, hash: snaps.hash };
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, action: 'login', url, error: String(e?.message ?? e) });
  }
}




