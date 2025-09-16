import fs from 'node:fs';
import path from 'node:path';
import type { NodeState } from '../utilities/types.js';

export class CsvWriter {
  private filePath: string;
  private stream: fs.WriteStream | null = null;
  private headers: string[];
  private clear: boolean;
  private nextId: number = 1; // CSV の id 列用の連番（ヘッダ行を除いた通し番号）

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
    } else {
      if (exists) {
        this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
        // 既存CSVのデータ行数+1 から開始（ヘッダ行は除く）
        this.nextId = (await countExistingDataRows(this.filePath)) + 1;
      } else {
        this.stream = fs.createWriteStream(this.filePath, { flags: 'w', encoding: 'utf8' });
        await this.writeLine(this.headers);
        this.nextId = 1;
      }
    }
  }

  async appendRow(values: Array<string | number | null | undefined>): Promise<void> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    const serialized = values.map((v) => serializeCsvField(v));
    await this.writeSerialized(serialized);
  }

  async appendNode(node: NodeState): Promise<void> {
    if (!this.stream) throw new Error('CSV writer not initialized');
    const snapshotForAIJson = JSON.stringify(node.snapshotForAI);
    const snapshotInMdJson = JSON.stringify(node.snapshotInMd);
    await this.appendRow([
      node.url,
      this.nextId,
      node.site,
      snapshotForAIJson,
      snapshotInMdJson,
      node.timestamp,
    ]);
    this.nextId += 1;
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
}

function serializeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // ダブルクォートで囲み、内部のダブルクォートはエスケープ（CSV RFC4180）
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

async function countExistingDataRows(filePath: string): Promise<number> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    // 末尾の空行を除去
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return 0;
    // 先頭行はヘッダ
    return Math.max(0, lines.length - 1);
  } catch {
    return 0;
  }
}


