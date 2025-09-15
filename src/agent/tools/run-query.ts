import { queryAll } from '../duckdb.js';
import { attachTodos } from './util.js';

export async function runQuery(query: string): Promise<string> {
  try {
    const q = String(query || '').trim();
    if (!q) {
      const payload = await attachTodos({ ok: false, error: 'エラー: query が空です' });
      return JSON.stringify(payload);
    }
    const rows = await queryAll<any>(q);
    if (!rows.length) {
      const payload = await attachTodos({ ok: true, result: '結果: 0 行' });
      return JSON.stringify(payload);
    }
    const lines: string[] = [];
    rows.slice(0, 20).forEach((rec, i) => lines.push(`行 ${i + 1}: ${JSON.stringify(rec)}`));
    if (rows.length > 20) lines.push(`\n... 他 ${rows.length - 20} 行`);
    const payload = await attachTodos({ ok: true, result: lines.join('\n') });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ ok: false, error: `エラー: ${String(e?.message ?? e)}` });
    return JSON.stringify(payload);
  }
}


