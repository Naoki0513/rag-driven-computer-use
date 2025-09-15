import { attachTodos } from './util.js';
import { queryAll } from '../duckdb.js';

// keyword_search: CSVのスナップショット列（"snapshotin MD"/"snapshotfor AI"）を AND 条件で検索し、関連URLを最大3件返す
export async function keywordSearch(keywords: string[]): Promise<string> {
  try {
    const list = Array.isArray(keywords)
      ? keywords.map((k) => String(k || '').trim()).filter((k) => k.length > 0)
      : [];
    if (!list.length) {
      const payload = await attachTodos({ ok: false, error: 'エラー: keywords が空です' });
      return JSON.stringify(payload);
    }

    // DuckDB: スナップショット列を連結して検索
    const conditions = list.map(() => "position(? in text) > 0").join(' AND ');
    const sql = `
WITH t AS (
  SELECT "URL" AS url,
         lower(coalesce("snapshotin MD", '') || ' ' || coalesce("snapshotfor AI", '')) AS text
  FROM pages
)
SELECT url
FROM t
WHERE ${conditions}
LIMIT 3`;
    const rows = await queryAll<{ url: string }>(sql, list.map((k) => k.toLowerCase()));
    if (!rows.length) {
      const payload = await attachTodos({ ok: true, result: '結果: 対象URLが見つかりませんでした' });
      return JSON.stringify(payload);
    }
    const lines: string[] = rows.map((r, i) => `URL ${i + 1}: ${r.url}`);
    const payload = await attachTodos({ ok: true, result: lines.join('\n') });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ ok: false, error: `エラー: ${String(e?.message ?? e)}` });
    return JSON.stringify(payload);
  }
}


