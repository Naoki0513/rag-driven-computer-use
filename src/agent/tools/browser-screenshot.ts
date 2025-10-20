import { ensureSharedBrowserStarted, formatToolError, attachTodos } from './util.js';
import { recordImageAttachment } from '../observability.js';

type ScreenshotInput = { query: string; fullPage?: boolean };

export async function browserScreenshot(input: ScreenshotInput): Promise<any> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const query = String((input as any)?.query ?? '').trim();
      const fullPage = ((input as any)?.fullPage === true) || String((input as any)?.fullPage ?? '').toLowerCase() === 'true';

      if (!query) {
        const payload = await attachTodos({ ok: 'Error: query is required', action: 'screenshot' });
        return JSON.stringify(payload);
      }

      console.log(`[browser_screenshot] Taking screenshot (fullPage: ${fullPage})...`);
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage });
      console.log(`[browser_screenshot] Screenshot captured (${screenshotBuffer.length} bytes)`);

      // BufferをBase64文字列に変換（JSON経由およびLangfuse自動抽出用のData URIを作成）
      const imageDataBase64 = screenshotBuffer.toString('base64');
      const dataUri = `data:image/png;base64,${imageDataBase64}`;

      const url = page.url();
      const todos = await (async () => {
        try {
          const { readTodoFileContent } = await import('./util.js');
          return await readTodoFileContent();
        } catch {
          return { path: 'todo.md', content: '' };
        }
      })();

      // Langfuse: 画像をデータURIとしてログ（SDKが自動でメディア抽出・アップロード）
      try {
        recordImageAttachment(fullPage ? 'Screenshot (fullPage)' : 'Screenshot (viewport)', dataUri, { url, fullPage });
      } catch {}

      // 画像バイナリを含むオブジェクトを返却（JSON文字列化しない）
      return {
        ok: true,
        action: 'screenshot',
        imageDataBase64,
        format: 'png',
        fullPage,
        url,
        todos
      };
    } catch (e: any) {
      const query = String((input as any)?.query ?? '').trim();
      const fullPage = ((input as any)?.fullPage === true) || String((input as any)?.fullPage ?? '').toLowerCase() === 'true';
      const payload = await attachTodos({ ok: formatToolError(e), action: 'screenshot', query, fullPage });
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'screenshot' });
    return JSON.stringify(payload);
  }
}

