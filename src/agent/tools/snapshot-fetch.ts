import { queryAll } from '../duckdb.js';
import { attachTodos } from './util.js';

type SnapshotFetchInput = {
  urls?: string[];
  ids?: string[];
};

type SnapshotRecord = {
  url: string;
  id: string;
  snapshotforai: string;
};

export async function snapshotFetch(input: SnapshotFetchInput): Promise<string> {
  try {
    const urls = Array.isArray((input as any)?.urls) ? (input as any).urls as string[] : [];
    const ids = Array.isArray((input as any)?.ids) ? (input as any).ids as string[] : [];
    
    const normalizedUrls = urls.map(u => String(u || '').trim()).filter(u => u.length > 0);
    const normalizedIds = ids.map(i => String(i || '').trim()).filter(i => i.length > 0);
    
    if (!normalizedUrls.length && !normalizedIds.length) {
      const payload = await attachTodos({ 
        ok: false, 
        action: 'snapshot_fetch', 
        error: 'Error: Specify urls or ids (or both)' 
      });
      return JSON.stringify(payload);
    }

    // クエリの構築（URLとIDの両方に対応）
    const conditions: string[] = [];
    
    if (normalizedUrls.length > 0) {
      const urlList = normalizedUrls.map(u => `'${u.replace(/'/g, "''")}'`).join(', ');
      conditions.push(`"URL" IN (${urlList})`);
    }
    
    if (normalizedIds.length > 0) {
      const idList = normalizedIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      conditions.push(`CAST(id AS VARCHAR) IN (${idList})`);
    }
    
    const whereClause = conditions.join(' OR ');
    const query = `SELECT "URL" AS url, CAST(id AS VARCHAR) AS id, snapshotforai FROM pages WHERE ${whereClause}`;
    
    const rows = await queryAll<SnapshotRecord>(query);
    
    if (!rows.length) {
      const payload = await attachTodos({ 
        ok: true, 
        action: 'snapshot_fetch', 
        results: [],
        note: 'No pages found matching the specified URL or ID'
      });
      return JSON.stringify(payload);
    }

    // 結果を整形
    const results = rows.map((row) => ({
      id: String(row.id ?? '').trim(),
      url: String(row.url ?? '').trim(),
      snapshotforai: String(row.snapshotforai ?? '').trim()
    }));

    const payload = await attachTodos({ 
      ok: true, 
      action: 'snapshot_fetch', 
      results,
      count: results.length
    });
    return JSON.stringify(payload);
  } catch (e: any) {
    const payload = await attachTodos({ 
      ok: false, 
      action: 'snapshot_fetch', 
      error: `Error: ${String(e?.message ?? e)}` 
    });
    return JSON.stringify(payload);
  }
}

