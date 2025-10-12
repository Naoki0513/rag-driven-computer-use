import fs from 'node:fs';
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

  async appendUrlOnly(url: string): Promise<number> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    return await this.withLock(async () => {
      // 既存URLなら既存IDを返す（行は更新しない）
      if (this.urlToIdMap.has(url)) {
        return this.urlToIdMap.get(url)!;
      }
      // 新規IDを予約
      const currentId = this.nextId;
      this.nextId += 1;
      this.urlToIdMap.set(url, currentId);
      // プレースホルダ行を追記（フルリライトしない）
      await this.appendRow([
        url,
        String(currentId),
        '',
        '',
        '',
      ]);
      try { console.info(`[CSV] URL discovered (placeholder upserted) ID=${currentId} -> ${url}`); } catch {}
      return currentId;
    });
  }

  async appendNode(node: NodeState): Promise<void> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    await this.appendNodeDedup(node);
  }

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
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolve) => {
      s.end(resolve);
    });
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

  private isFullValues(values: string[]): boolean {
    const site = (values[2] || '').trim();
    const snap = (values[3] || '').trim();
    const ts = (values[4] || '').trim();
    return !!(site || snap || ts);
  }

  private async replaceOrAppendRow(newValues: string[], preferFull: boolean): Promise<void> {
    // 一時的にストリームを閉じて安全に全体書き換え
    if (this.stream) await this.close();
    const tmpPath = `${this.filePath}.tmp`;

    let content = '';
    try {
      content = await fs.promises.readFile(this.filePath, 'utf8');
    } catch {}

    const headerLine = this.headers.map((h) => serializeCsvField(h)).join(',');
    const lines = content ? content.split(/\r?\n/) : [];
    const out: string[] = [];
    if (lines.length === 0 || (lines[0] || '') !== headerLine) {
      out.push(headerLine);
    } else {
      out.push(lines[0]!);
    }

    const targetUrl = newValues[0] || '';
    const newIsFull = this.isFullValues(newValues);
    let found = false;

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] || '';
      if (!line.trim()) continue;
      let fields: string[];
      try { fields = parseCsvLine(line); } catch { out.push(line); continue; }
      if ((fields[0] || '') === targetUrl) {
        found = true;
        const oldIsFull = this.isFullValues(fields);
        let keepValues: string[] = fields;
        if (newIsFull && !oldIsFull) {
          keepValues = newValues;
        } else if (!newIsFull && oldIsFull) {
          keepValues = fields; // ダウングレードしない
        } else if (newIsFull && oldIsFull) {
          keepValues = preferFull ? newValues : fields;
        } else {
          // 両方プレースホルダ：既存を保持
          keepValues = fields;
        }
        out.push(keepValues.map((v) => serializeCsvField(v)).join(','));
      } else {
        out.push(line);
      }
    }

    if (!found) {
      out.push(newValues.map((v) => serializeCsvField(v)).join(','));
    }

    await fs.promises.writeFile(tmpPath, out.join('\n') + '\n', 'utf8');
    await fs.promises.rename(tmpPath, this.filePath);
    // 追記用ストリームを再オープン
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
  }
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

  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    
    // 末尾の空行を除去
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    
    if (lines.length <= 1) return result; // ヘッダのみまたは空ファイル
    
    // データ行を解析（ヘッダ行をスキップ）
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      
      try {
        // 簡易CSVパーサー（ダブルクォートで囲まれた値を考慮）
        const fields = parseCsvLine(line);
        if (fields.length >= 2) {
          const url = fields[0] || '';
          const idStr = fields[1] || '';
          const site = fields[2] || '';
          const snapshotForAIField = fields[3] || '';
          const timestamp = fields[4] || '';
          const id = parseInt(idStr, 10);
          
          if (url && !isNaN(id)) {
            // URLとIDのマッピングを記録（最初に見つかったもののみ）
            if (!result.urlToIdMap.has(url)) {
              result.urlToIdMap.set(url, id);
            }
            // 最大IDを更新
            if (id > result.maxId) {
              result.maxId = id;
            }
            // フルデータ行の検出（site、snapshotForAI、timestampのいずれかが存在する場合）
            if (fields.length >= 5 && (site.trim() || (snapshotForAIField || '').trim() || timestamp.trim())) {
              result.fullDataUrls.add(url);
            }

            // スナップショット文字列からハッシュを復元
            try {
              let snapshotText = '';
              const raw = snapshotForAIField;
              if (raw && raw.trim().length > 0) {
                try {
                  // 既存は JSON.stringify で格納されている想定
                  snapshotText = JSON.parse(raw);
                  if (typeof snapshotText !== 'string') snapshotText = String(snapshotText ?? '');
                } catch {
                  // 非JSON格納の互換（安全側）
                  snapshotText = raw;
                }
              }
              const hash = computeSha256Hex(snapshotText);
              if (snapshotText && hash) {
                result.snapshotHashByUrl.set(url, hash);
                result.snapshotHashSet.add(hash);
              }
            } catch {}
          }
        }
      } catch (parseErr) {
        // パース失敗した行は無視
        continue;
      }
    }
    
    result.dataRowCount = lines.length - 1; // ヘッダ行を除いたデータ行数
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


