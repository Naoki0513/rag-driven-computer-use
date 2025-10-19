import { ensureSharedBrowserStarted, captureAndStoreSnapshot, formatToolError, attachTodos, rerankSnapshotTopChunks } from './util.js';
import { getTimeoutMs } from '../../utilities/timeout.js';

type EvaluateInput = { script: string; arg?: any; query: string };

export async function browserEvaluateScript(input: EvaluateInput): Promise<string> {
  try {
    const { page } = await ensureSharedBrowserStarted();
    try {
      const t = getTimeoutMs('agent');
      const script = String((input as any)?.script ?? '');
      const query = String((input as any)?.query ?? '').trim();
      const arg = (input as any)?.arg;

      if (!query) return JSON.stringify(await attachTodos({ ok: 'Error: query is required', action: 'evaluate' }));
      if (!script) return JSON.stringify(await attachTodos({ ok: 'Error: script is required', action: 'evaluate' }));

      // 可能な限り安全に evaluate し、戻り値は JSON.stringify 可能な範囲に収める
      const result = arg !== undefined
        ? await page.evaluate((args: any[]) => {
            const [code, a] = args;
            // eslint-disable-next-line no-new-func
            const fn = new Function('arg', `return (async () => { ${code}\n})();`);
            return Promise.resolve(fn(a)).then((r) => r);
          }, [script, arg])
        : await page.evaluate((args: any[]) => {
            const [code] = args;
            // eslint-disable-next-line no-new-func
            const fn = new Function('', `return (async () => { ${code}\n})();`);
            return Promise.resolve(fn()).then((r) => r);
          }, [script]);

      const snaps = await captureAndStoreSnapshot(page);
      let top: Array<{ score: number; text: string }> = [];
      try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
      const payload = await attachTodos({ ok: true, action: 'evaluate', result: (typeof result === 'string' ? result : JSON.stringify(result ?? null)), snapshots: { top: top.map(({ text }) => ({ text })), url: snaps.url } });
      return JSON.stringify(payload);
    } catch (e: any) {
      let snaps: { text: string; hash: string; url: string } | null = null;
      try { snaps = await captureAndStoreSnapshot((await ensureSharedBrowserStarted()).page); } catch {}
      const script = String((input as any)?.script ?? '');
      const query = String((input as any)?.query ?? '').trim();
      let payload: any = { ok: formatToolError(e), action: 'evaluate', scriptPreview: script.slice(0, 200), query };
      if (snaps) {
        let top: Array<{ score: number; text: string }> = [];
        try { top = query ? await rerankSnapshotTopChunks(snaps.text, query) : []; } catch {}
        payload.snapshots = { top: top.map(({ text }) => ({ text })), url: snaps.url };
      }
      payload = await attachTodos(payload);
      return JSON.stringify(payload);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: formatToolError(e), action: 'evaluate' });
    return JSON.stringify(payload);
  }
}






