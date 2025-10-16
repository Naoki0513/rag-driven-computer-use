import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import type { NodeState } from '../utilities/types.js';
import { computeSha256Hex } from '../utilities/text.js';

export class CsvWriter {
  private filePath: string;
  private stream: fs.WriteStream | null = null;
  private headers: string[];
  private clear: boolean;
  private nextId: number = 1; // CSV の id 列用の連番（ヘッダ行を除いた通し番号）
  private urlToIdMap: Map<string, number> = new Map(); // URL → id のマッピング
  private fullDataWritten = new Set<string>(); // フルデータ書き込み済みURL管理
  private snapshotHashByUrl: Map<string, string> = new Map(); // URL -> snapshot hash
  private snapshotHashSet: Set<string> = new Set(); // 既存スナップショットのハッシュ集合（重複排除用）
  private lockQueue: Promise<void> = Promise.resolve(); // ファイル書込みの直列化用

  constructor(filePath: string, headers: string[], options?: { clear?: boolean }) {
    this.filePath = path.resolve(filePath);
    this.headers = headers;
    this.clear = !!(options?.clear);
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

    const exists = fs.existsSync(this.filePath);
    if (this.clear) {
      try { if (exists) await fs.promises.unlink(this.filePath); } catch {}
      this.stream = fs.createWriteStream(this.filePath, { flags: 'w', encoding: 'utf8' });
      await this.writeLine(this.headers);
      // 新規作成（クリア）時は 1 から開始
      this.nextId = 1;
      this.urlToIdMap.clear();
      this.fullDataWritten.clear();
    } else {
      if (exists) {
        // 既存CSVからIDとURLマッピングを復元
        const existingData = await loadExistingCsvData(this.filePath);
        this.urlToIdMap = existingData.urlToIdMap;
        this.fullDataWritten = existingData.fullDataUrls; // フルデータ書き込み済みURLを復元
        this.snapshotHashByUrl = existingData.snapshotHashByUrl;
        this.snapshotHashSet = existingData.snapshotHashSet;
        this.nextId = existingData.maxId + 1; // 最大ID + 1 から開始

        this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });

        try { 
          console.info(`[CSV] loaded existing data: ${existingData.urlToIdMap.size} URLs, ${existingData.fullDataUrls.size} full data, maxId=${existingData.maxId}, nextId=${this.nextId}, hashes=${existingData.snapshotHashSet.size}`); 
        } catch {}
      } else {
        this.stream = fs.createWriteStream(this.filePath, { flags: 'w', encoding: 'utf8' });
        await this.writeLine(this.headers);
        this.nextId = 1;
        this.urlToIdMap.clear();
        this.fullDataWritten.clear();
        this.snapshotHashByUrl.clear();
        this.snapshotHashSet.clear();
      }
    }
  }

  async appendRow(values: Array<string | number | null | undefined>): Promise<void> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    const serialized = values.map((v) => serializeCsvField(v));
    await this.writeSerialized(serialized);
  }

  // appendNode は未使用のため削除（appendNodeDedup を直接使用）

  // 重複排除＆再実行時上書き対応付きのフル行書込み
  async appendNodeDedup(
    node: NodeState,
    options?: { mode?: 'hash' | 'string' }
  ): Promise<'insert' | 'skip-dup' | 'update'> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    const mode = options?.mode === 'string' ? 'string' : 'hash';
    return await this.withLock(async () => {
      const snapshotText = node.snapshotForAI ?? '';
      const newHash = mode === 'hash' ? computeSha256Hex(snapshotText) : snapshotText;

      const existingHashForUrl = this.snapshotHashByUrl.get(node.url) || null;

      // グローバル重複（URLが異なっていても内容が同じ）ならスキップ
      if (existingHashForUrl === null && this.snapshotHashSet.has(newHash)) {
        try { console.info(`[DEDUP] skip same-hash url=${node.url} hash=${newHash}`); } catch {}
        return 'skip-dup';
      }

      let idToUse: number;
      if (this.urlToIdMap.has(node.url)) {
        idToUse = this.urlToIdMap.get(node.url)!;
      } else {
        idToUse = this.nextId;
        this.nextId += 1;
        this.urlToIdMap.set(node.url, idToUse);
      }

      const snapshotForAIJson = JSON.stringify(snapshotText);

      // 既存URLでハッシュが同一ならスキップ
      if (existingHashForUrl && existingHashForUrl === newHash) {
        try { console.info(`[CSV] skip-dup (same url/hash) ID=${idToUse} -> ${node.url}`); } catch {}
        return 'skip-dup';
      }

      // 書込み（追記のみ）
      await this.appendRow([
        node.url,
        String(idToUse),
        node.site,
        snapshotForAIJson,
        node.timestamp,
      ]);

      // インデックス更新
      this.fullDataWritten.add(node.url);
      this.snapshotHashByUrl.set(node.url, newHash);
      this.snapshotHashSet.add(newHash);

      if (existingHashForUrl && existingHashForUrl !== newHash) {
        try { console.info(`[CSV] update ID=${idToUse} -> ${node.url} hash=${newHash}`); } catch {}
        return 'update';
      }
      try { console.info(`[CSV] insert ID=${idToUse} -> ${node.url} hash=${newHash}`); } catch {}
      return 'insert';
    });
  }

  async close(): Promise<void> {
    if (!this.stream) {
      // ストリームが既に閉じられている場合でも、念のためコンパクションを試みる
      try { await this.compactOnClose(); } catch {}
      return;
    }
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolve) => {
      s.end(resolve);
    });
    // 追記完了後に一括コンパクション（URLごとに最新行のみ保持）
    try { await this.compactOnClose(); } catch {}
  }

  private async writeLine(values: string[]): Promise<void> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    const serialized = values.map((v) => serializeCsvField(v));
    await this.writeSerialized(serialized);
  }

  private async writeSerialized(serializedValues: string[]): Promise<void> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    const line = serializedValues.join(',') + '\n';
    const ok = this.stream.write(line, 'utf8');
    if (!ok) {
      await new Promise<void>((resolve) => this.stream?.once('drain', () => resolve()));
    }
  }

  // 終了時の一括コンパクション
  // - URL ごとに最新 timestamp の行を採用
  // - 同一 timestamp の場合はフル行（site/snapshot/timestamp のいずれか有り）を優先
  // - なお同点なら最後に出現した行を採用
  private async compactOnClose(): Promise<void> {
    const headerLine = this.headers.map((h) => serializeCsvField(h)).join(',');
    if (!fs.existsSync(this.filePath)) return;

    // 第1パス: URLごとの最良行の行インデックスだけ決める
    type PickMeta = { tsMs: number; isFull: boolean; index: number };
    const bestByUrl = new Map<string, PickMeta>();
    try {
      const rs1 = fs.createReadStream(this.filePath, { encoding: 'utf8' });
      const rl1 = readline.createInterface({ input: rs1, crlfDelay: Infinity });
      let idx = 0;
      for await (const line of rl1 as any) {
        if (idx === 0) { idx += 1; continue; }
        const trimmed = (line ?? '').trim();
        if (!trimmed) { idx += 1; continue; }
        let fields: string[];
        try { fields = parseCsvLine(trimmed); } catch { idx += 1; continue; }
        if (fields.length < 2) { idx += 1; continue; }
        const url = fields[0] || '';
        if (!url) { idx += 1; continue; }
        const site = (fields[2] || '').trim();
        const snap = (fields[3] || '').trim();
        const ts = (fields[4] || '').trim();
        const isFull = !!(site || snap || ts);
        let tsMs = 0;
        if (ts) {
          const parsed = Date.parse(ts);
          if (!Number.isNaN(parsed)) tsMs = parsed;
        }
        const prev = bestByUrl.get(url);
        if (!prev) {
          bestByUrl.set(url, { tsMs, isFull, index: idx });
          idx += 1; continue;
        }
        if (tsMs > prev.tsMs) {
          bestByUrl.set(url, { tsMs, isFull, index: idx });
          idx += 1; continue;
        }
        if (tsMs < prev.tsMs) { idx += 1; continue; }
        if (isFull && !prev.isFull) {
          bestByUrl.set(url, { tsMs, isFull, index: idx });
          idx += 1; continue;
        }
        if (!isFull && prev.isFull) { idx += 1; continue; }
        if (idx >= prev.index) {
          bestByUrl.set(url, { tsMs, isFull, index: idx });
        }
        idx += 1;
      }
    } catch {
      return;
    }

    const chosenIndexes = new Set<number>(Array.from(bestByUrl.values()).sort((a, b) => a.index - b.index).map(v => v.index));

    // 第2パス: 選ばれた行のみを書き出す
    const tmpPath = `${this.filePath}.compact.tmp`;
    const ws = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
    await new Promise<void>((resolve, reject) => {
      ws.write(headerLine + '\n', 'utf8', (err) => err ? reject(err) : resolve());
    });
    try {
      const rs2 = fs.createReadStream(this.filePath, { encoding: 'utf8' });
      const rl2 = readline.createInterface({ input: rs2, crlfDelay: Infinity });
      let idx2 = 0;
      for await (const line of rl2 as any) {
        if (idx2 === 0) { idx2 += 1; continue; }
        if (chosenIndexes.has(idx2)) {
          await new Promise<void>((resolve) => {
            ws.write((line ?? '') + '\n', 'utf8', () => resolve());
          });
        }
        idx2 += 1;
      }
    } catch {
      try { ws.end(); } catch {}
      try { await fs.promises.unlink(tmpPath); } catch {}
      return;
    }
    await new Promise<void>((resolve) => ws.end(() => resolve()));
    await fs.promises.rename(tmpPath, this.filePath);
    try { console.info(`[CSV] compacted: unique URLs=${bestByUrl.size}`); } catch {}
  }

  // 以降は内部ユーティリティ
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockQueue;
    let release!: () => void;
    this.lockQueue = new Promise<void>((res) => { release = res; });
    await prev;
    try {
      const result = await fn();
      release();
      return result;
    } catch (e) {
      release();
      throw e;
    }
  }

  // isFullValues / replaceOrAppendRow は未使用のため削除
}

function serializeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // ダブルクォートで囲み、内部のダブルクォートはエスケープ（CSV RFC4180）
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

async function loadExistingCsvData(filePath: string): Promise<{ maxId: number; urlToIdMap: Map<string, number>; dataRowCount: number; fullDataUrls: Set<string>; snapshotHashByUrl: Map<string, string>; snapshotHashSet: Set<string> }> {
  const result = {
    maxId: 0,
    urlToIdMap: new Map<string, number>(),
    dataRowCount: 0,
    fullDataUrls: new Set<string>(),
    snapshotHashByUrl: new Map<string, string>(),
    snapshotHashSet: new Set<string>(),
  };

  if (!fs.existsSync(filePath)) return result;

  try {
    const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
    let lineIndex = 0;
    for await (const line of rl as any) {
      if (lineIndex === 0) { lineIndex += 1; continue; }
      lineIndex += 1;
      const trimmed = (line ?? '').trim();
      if (!trimmed) continue;
      try {
        const fields = parseCsvLine(trimmed);
        if (fields.length < 2) continue;
        const url = fields[0] || '';
        const idStr = fields[1] || '';
        const site = (fields[2] || '').trim();
        const snapshotForAIField = fields[3] || '';
        const timestamp = (fields[4] || '').trim();
        const id = parseInt(idStr, 10);
        if (!url || Number.isNaN(id)) continue;

        if (!result.urlToIdMap.has(url)) result.urlToIdMap.set(url, id);
        if (id > result.maxId) result.maxId = id;
        if (fields.length >= 5 && (site || (snapshotForAIField || '').trim() || timestamp)) {
          result.fullDataUrls.add(url);
        }

        // スナップショット本文は保持せず、ハッシュのみ復元
        try {
          let snapshotText = '';
          const raw = snapshotForAIField;
          if (raw && raw.trim().length > 0) {
            try {
              const parsed = JSON.parse(raw);
              snapshotText = typeof parsed === 'string' ? parsed : String(parsed ?? '');
            } catch {
              snapshotText = raw;
            }
          }
          if (snapshotText) {
            const hash = computeSha256Hex(snapshotText);
            if (hash) {
              result.snapshotHashByUrl.set(url, hash);
              result.snapshotHashSet.add(hash);
            }
          }
        } catch {}
      } catch {}
    }
    result.dataRowCount = Math.max(0, lineIndex - 1);
    return result;
  } catch {
    return result;
  }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  
  while (i < line.length) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // エスケープされたクォート
        current += '"';
        i += 2;
      } else {
        // クォートの開始/終了
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      // フィールド区切り
      result.push(current);
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }
  
  // 最後のフィールドを追加
  result.push(current);
  return result;
}

async function countExistingDataRows(filePath: string): Promise<number> {
  const data = await loadExistingCsvData(filePath);
  return data.dataRowCount;
}


