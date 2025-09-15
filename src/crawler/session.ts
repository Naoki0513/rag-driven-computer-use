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
  const loginInput = await page.$('input[name="emailOrUsername"], input[name="username"], input[name="email"], input[type="email"], input[type="text"][placeholder*="user" i]');
  const passwordInput = await page.$('input[type="password"]');
  const submitButton = await page.$('button.login, button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")');
  if (loginInput && passwordInput && submitButton) {
    await loginInput.fill(config.loginUser);
    await passwordInput.fill(config.loginPass);
    await submitButton.click({ timeout: t });
    await page.waitForTimeout(Math.min(5000, t));
  }
}


