import duckdb from 'duckdb';
import path from 'path';

let _db: duckdb.Database | null = null;
let _con: duckdb.Connection | null = null;
let _initialized = false;

function getCsvPath(): string {
  const envPath = String(process.env.AGENT_CSV_PATH || '').trim();
  if (envPath) return envPath;
  // 既定: リポジトリの output/crawl.csv
  return path.resolve(process.cwd(), 'output', 'crawl.csv');
}

async function initIfNeeded(): Promise<void> {
  if (_initialized && _db && _con) return;
  _db = new duckdb.Database(':memory:');
  _con = _db.connect();
  const csv = getCsvPath();
  const csvEscaped = csv.replace(/'/g, "''");
  // CSV を pages ビューとして読む（ヘッダーあり、型は自動推定）
  await exec(`CREATE OR REPLACE VIEW pages AS SELECT * FROM read_csv_auto('${csvEscaped}', HEADER=true);`);
  _initialized = true;
}

async function exec(sql: string, params: any[] = []): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const con = _con || (_db && _db.connect());
    if (!con) return reject(new Error('DuckDB connection not available'));
    if (Array.isArray(params) && params.length > 0) {
      (con as any).run(sql, params, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    } else {
      (con as any).run(sql, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    }
  });
}

export async function queryAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  await initIfNeeded();
  return await new Promise<T[]>((resolve, reject) => {
    const con = _con!;
    if (Array.isArray(params) && params.length > 0) {
      (con as any).all(sql, params, (err: any, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows as T[]);
      });
    } else {
      (con as any).all(sql, (err: any, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows as T[]);
      });
    }
  });
}

export async function getCsvSchemaString(): Promise<string> {
  await initIfNeeded();
  const csvPath = getCsvPath();
  try {
    const cols = await queryAll<{ name: string; type: string }>(
      `PRAGMA table_info('pages')`
    );
    const countRows = await queryAll<{ c: number }>(`SELECT COUNT(*) AS c FROM pages`);
    const samples = await queryAll<{ URL?: string; url?: string; site?: string }>(
      `SELECT * FROM pages LIMIT 3`
    );
    const lines: string[] = [];
    lines.push('CSV source: ' + csvPath);
    lines.push('- Column info:');
    if (cols.length) {
      for (const c of cols) lines.push(`  - ${c.name}: ${c.type || 'UNKNOWN'}`);
    } else {
      lines.push('  - Failed to retrieve');
    }
    lines.push('');
    lines.push(`- Total rows: ${countRows[0]?.c ?? 'Unknown'}`);
    lines.push('');
    lines.push('- Sample rows (max 3):');
    if (samples.length) {
      for (let i = 0; i < samples.length; i += 1) {
        const rec = samples[i]!;
        const url = (rec as any).URL || (rec as any).url || '';
        lines.push(`  - ${i + 1}: ${url ? `URL=${url}` : JSON.stringify(rec)}`);
      }
    } else {
      lines.push('  - None');
    }
    return lines.join('\n');
  } catch (e: any) {
    return `Schema fetch error: ${String(e?.message ?? e)}`;
  }
}


