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
  await page.goto(config.targetUrl, { waitUntil: 'commit', timeout: t }).catch(() => {});
  try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 10000) }); } catch {}
  try { await page.waitForLoadState('load', { timeout: Math.min(t, 15000) }); } catch {}
  await page.waitForTimeout(Math.min(3000, t));
  const isAlreadyLoggedIn = await page.evaluate<boolean>(
    'Boolean(document.querySelector(".sidebar") || document.querySelector(".main-content") || document.querySelector(".rc-room"))',
  );
  if (isAlreadyLoggedIn) return;
  const currentUrl = page.url();
  if (currentUrl.includes('/home')) {
    const baseUrl = config.targetUrl.replace(/\/home\/?$/, '');
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: t }).catch(() => {});
    try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(t, 10000) }); } catch {}
    await page.waitForTimeout(Math.min(2000, t));
  }
  try {
    const userLocator = page.locator('input[name="emailOrUsername"], input[name="username"], input[name="email"], input[type="email"], input[type="text"][placeholder*="user" i]').first();
    const passLocator = page.locator('input[type="password"]').first();
    const submitLocator = page.locator('button.login, button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")').first();

    const [userVisible, passVisible, submitVisible] = await Promise.all([
      userLocator.isVisible().catch(() => false),
      passLocator.isVisible().catch(() => false),
      submitLocator.isVisible().catch(() => false),
    ]);

    if (userVisible && passVisible) {
      await userLocator.fill(config.loginUser, { timeout: Math.min(2000, t) }).catch(() => {});
      await passLocator.fill(config.loginPass, { timeout: Math.min(2000, t) }).catch(() => {});
      if (submitVisible) {
        await submitLocator.click({ timeout: Math.min(3000, t) }).catch(() => {});
      }
      await page.waitForTimeout(Math.min(5000, t)).catch(() => {});
    }
  } catch {}
}


