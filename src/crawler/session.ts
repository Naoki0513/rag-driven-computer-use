import type { Page } from 'playwright';
import { getTimeoutMs } from '../utilities/timeout.js';

export type SessionConfig = {
  targetUrl: string;
  loginUrl?: string;
  loginUser: string;
  loginPass: string;
};

export async function login(page: Page, config: SessionConfig): Promise<void> {
  const t = getTimeoutMs('crawler');
  // 可能ならログインページへ移動（呼び出し元でも遷移しているが冪等）
  if (config.loginUrl) {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: t }).catch(() => {});
  }
  try { await page.waitForLoadState('load', { timeout: Math.min(t, 15000) }); } catch {}
  await page.waitForTimeout(Math.min(1000, t));

  // ログイン済みの簡易判定: 明示的なログアウト要素があるか
  const hasLogout = await Promise.race([
    page.getByRole('link', { name: /sign\s*out|log\s*out|logout|サインアウト|ログアウト/i }).isVisible().catch(() => false),
    page.getByRole('button', { name: /sign\s*out|log\s*out|logout|サインアウト|ログアウト/i }).isVisible().catch(() => false),
  ]).catch(() => false) as boolean;
  if (hasLogout) return;

  // ログインフォーム検出のヘルパ
  async function pickVisible(cands: any[]): Promise<any | null> {
    for (const loc of cands) {
      const ok = await (loc?.isVisible?.().catch(() => false) ?? false);
      if (ok) return loc;
    }
    return null;
  }

  try {
    const userCands = [
      page.getByLabel(/email|e-mail|メール|eメール/i).first(),
      page.getByLabel(/user\s*name|username|ユーザー名/i).first(),
      page.locator('input[type="email"]').first(),
      page.locator('input[name*="email" i]').first(),
      page.locator('input[id*="email" i]').first(),
      page.locator('input[placeholder*="email" i]').first(),
      page.locator('input[name*="user" i]').first(),
      page.locator('input[id*="user" i]').first(),
      page.locator('input[type="text"]').first(),
    ];
    const passCands = [
      page.getByLabel(/password|パスワード/i).first(),
      page.locator('input[type="password"]').first(),
    ];
    const submitCands = [
      page.getByRole('button', { name: /sign\s*in|log\s*in|login|submit|サインイン|ログイン/i }).first(),
      page.locator('button[type="submit"]').first(),
      page.locator('input[type="submit"]').first(),
      page.locator('button').filter({ hasText: /sign\s*in|log\s*in|login|submit|サインイン|ログイン/i }).first(),
    ];

    const userLocator = await pickVisible(userCands);
    const passLocator = await pickVisible(passCands);
    if (userLocator && passLocator) {
      await userLocator.fill(config.loginUser, { timeout: Math.min(4000, t) }).catch(() => {});
      await passLocator.fill(config.loginPass, { timeout: Math.min(4000, t) }).catch(() => {});

      const submitLocator = await pickVisible(submitCands);
      const prevUrl = page.url();
      const urlWaiter = page
        .waitForFunction((prev) => window.location.href !== prev, prevUrl, { timeout: Math.min(t, 7000) })
        .then(() => true)
        .catch(() => false);
      if (submitLocator) {
        await submitLocator.click({ timeout: Math.min(4000, t) }).catch(() => {});
      } else {
        try { await passLocator.press('Enter', { timeout: Math.min(2000, t) }); } catch {}
      }
      const changed = await urlWaiter.catch(() => false);
      if (!changed) {
        try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 5000) }); } catch {}
        await page.waitForTimeout(500).catch(() => {});
      }
    }
  } catch {}

  // ログイン後はトップへ移動してクロール開始
  try { await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(t, 10000) }); } catch {}
}


