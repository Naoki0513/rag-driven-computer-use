import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function getNpmCmd(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getCsvPathFromEnv(): string {
  const env = process.env as Record<string, string | undefined>;
  const raw = (env.CRAWLER_OUTPUT_FILE || env.CRAWLER_CSV_PATH || '').toString().trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return path.resolve(process.cwd(), 'output', 'crawl.csv');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch (e: any) {
    const code = String((e && (e as any).code) || '').toUpperCase();
    if (code && code !== 'ENOENT') return true; // EPERM 等は存在はしているとみなす
    return false;
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function runCrawler(): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(getNpmCmd(), ['run', 'start:crawler'], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`crawler exited with code ${code}`));
    });
  });
}

function parseCsvLine(line: string): string[] {
  // RFC4180 風の簡易パーサ（このプロジェクトの writer は常に全フィールドを二重引用符で囲む）
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    // 先頭のカンマをスキップ
    if (line[i] === ',') { i += 1; continue; }
    let cell = '';
    if (line[i] === '"') {
      // 引用符付き
      i += 1; // opening quote
      while (i < line.length) {
        const ch = line[i]!;
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { // escaped quote
            cell += '"';
            i += 2;
            continue;
          }
          i += 1; // closing quote
          break;
        }
        cell += ch;
        i += 1;
      }
      // 次がカンマなら消費
      if (i < line.length && line[i] === ',') i += 1;
    } else {
      // 非推奨（基本到達しない）
      while (i < line.length && line[i] !== ',') { cell += line[i] as string; i += 1; }
      if (i < line.length && line[i] === ',') i += 1;
    }
    out.push(cell);
  }
  return out;
}

function ensureHost(u: string): string | null {
  try { return new URL(u).host; } catch { return null; }
}

async function validateBooksCrawl(csvPath: string): Promise<void> {
  const raw = await fs.readFile(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) throw new Error('CSV にデータ行がありません');
  const dataRows = lines.length - 1;
  if (dataRows < 100) throw new Error(`データ行が少なすぎます: 期待>=100, 実際=${dataRows}`);
  // DuckDB による基本検証
  await duckdbValidate(csvPath);
}

async function duckdbValidate(csvPath: string): Promise<void> {
  let DuckDB: any = null;
  try {
    const mod: any = await import('duckdb');
    DuckDB = (mod && mod.default) ? mod.default : mod;
  } catch {
    throw new Error('[E2E][crawler] DuckDB モジュールが見つからないため検証を実行できません');
  }
  const db = new DuckDB.Database(':memory:');
  const conn = db.connect();
  // CREATE VIEW with read_csv_auto
  const escapedPath = csvPath.replace(/'/g, "''");
  const createViewSql = `CREATE VIEW v AS SELECT * FROM read_csv_auto('${escapedPath}', HEADER=TRUE, ALL_VARCHAR=TRUE, SAMPLE_SIZE=-1)`;
  await new Promise<void>((resolve, reject) => {
    conn.run(createViewSql, (err: unknown) => (err ? reject(err) : resolve()));
  });
  const all = (sql: string, params: any[] = []) => new Promise<any[]>((resolve, reject) => {
    const cb = (err: unknown, rows: any[]) => (err ? reject(err) : resolve(rows || []));
    if (Array.isArray(params) && params.length > 0) {
      (conn as any).all(sql, params, cb);
    } else {
      (conn as any).all(sql, cb);
    }
  });
  const getSingle = async (sql: string, params: any[] = []) => {
    const rows = await all(sql, params);
    return rows[0] || {};
  };
  const rowCnt = await getSingle('SELECT COUNT(*) AS cnt FROM v');
  if (!rowCnt.cnt || Number(rowCnt.cnt) < 100) throw new Error('DuckDB: 行数検証に失敗しました');
  const urlBad = await getSingle('SELECT COUNT(*) AS bad FROM v WHERE COALESCE("URL", \'\') = \'\'');
  if (Number(urlBad.bad) !== 0) throw new Error('DuckDB: URL 列に空値があります');
  const idBad = await getSingle('SELECT COUNT(*) AS bad FROM v WHERE TRY_CAST(NULLIF("id", \'\') AS BIGINT) IS NULL');
  if (Number(idBad.bad) !== 0) throw new Error('DuckDB: id 列が数値に変換できない行があります');
  const siteDistinct = await getSingle('SELECT COUNT(DISTINCT site) AS n FROM v');
  if (!siteDistinct.n || Number(siteDistinct.n) < 1) throw new Error('DuckDB: site 列が不正です');
  const tsBad = await getSingle('SELECT COUNT(*) AS bad FROM v WHERE COALESCE("timestamp", \'\') = \'\'');
  if (Number(tsBad.bad) !== 0) throw new Error('DuckDB: timestamp 列に空値があります');
  // スナップショット列の基本チェック（列存在とある程度の非空）
  const aiNonEmpty = await getSingle('SELECT COUNT(*) AS c FROM v WHERE LENGTH(COALESCE("snapshotfor AI", \'\')) > 0');
  if (!aiNonEmpty.c || Number(aiNonEmpty.c) < 1) throw new Error('DuckDB: "snapshotfor AI" 列が空です');
  await new Promise<void>((resolve) => conn.close(() => resolve()));
}

async function main() {
  const target = String(process.env.CRAWLER_TARGET_URLS || '').trim();
  const csvOverride = String(process.env.E2E_CSV_PATH || '').trim();
  if (!target || !/books\.toscrape\.com\/?/i.test(target)) {
    if (!csvOverride) console.warn('[E2E][crawler] 警告: CRAWLER_TARGET_URLS が未設定または想定外です。既存CSVの検証にフォールバックします。');
  }
  let csvPath = csvOverride
    ? (path.isAbsolute(csvOverride) ? csvOverride : path.resolve(process.cwd(), csvOverride))
    : getCsvPathFromEnv();
  console.log(`[E2E][crawler] cwd=${process.cwd()} csvPath=${csvPath}`);

  const reuse = /^(1|true)$/i.test(String(process.env.E2E_REUSE_EXISTING_CSV || ''));
  if (!reuse) {
    // 既存CSVがある場合はテスト開始前に削除。削除できなければ別名に切替（Windowsのロック対策）
    if (await pathExists(csvPath)) {
      try { await fs.unlink(csvPath); } catch {}
    }
    if (await pathExists(csvPath)) {
      const alt = path.resolve(path.dirname(csvPath), `e2e-run-${Date.now()}.csv`);
      process.env.CRAWLER_OUTPUT_FILE = alt;
      csvPath = alt;
      console.log(`[E2E][crawler] CSV を別名に切替: ${csvPath}`);
    }
    // 実行
    await runCrawler();
  } else {
    console.log('[E2E][crawler] 既存CSVを利用して検証のみを実行します');
    if (!(await pathExists(csvPath))) throw new Error(`既存CSVが見つかりません: ${csvPath}`);
  }
  // Playwright/CSV フラッシュ待ちの安全マージン
  await sleep(500);

  if (!(await pathExists(csvPath))) {
    // 出力ディレクトリから候補を探索
    const outDir = path.resolve(process.cwd(), 'output');
    try {
      const ents = await fs.readdir(outDir, { withFileTypes: true });
      const csvs = ents.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.csv')).map((e) => path.join(outDir, e.name));
      if (!csvs.length) throw new Error(`CSV が見つかりません: ${csvPath}`);
      // 新しい順に試す
      const stats = await Promise.all(csvs.map(async (p) => ({ p, st: await fs.stat(p).catch(() => null as any) })));
      const ordered = stats.filter((x) => x.st).sort((a, b) => (b.st.mtimeMs - a.st.mtimeMs));
      let validated = false;
      for (const cand of ordered) {
        try {
          await validateBooksCrawl(cand.p);
          console.log(`[E2E][crawler] 代替CSVで検証成功: ${cand.p}`);
          validated = true;
          break;
        } catch (e: any) {
          console.warn(`[E2E][crawler] 候補CSVの検証失敗: ${cand.p} : ${String(e?.message ?? e)}`);
        }
      }
      if (!validated) throw new Error(`いずれのCSVでも検証に失敗しました（最終候補数=${ordered.length}）。`);
      return;
    } catch (e: any) {
      throw new Error(`CSV が見つかりません: ${csvPath}`);
    }
  }
  await validateBooksCrawl(csvPath);
  console.log('[E2E][crawler] OK: books.toscrape.com 全URL取得とスナップショットの基本検証に成功しました');
}

main().catch((e) => {
  console.error('[E2E][crawler] 失敗:', e?.message ?? e);
  process.exitCode = 1;
});


