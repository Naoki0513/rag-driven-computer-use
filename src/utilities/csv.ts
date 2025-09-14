import fs from 'node:fs';
import path from 'node:path';
import type { NodeState } from './types.js';

export class CsvWriter {
  private filePath: string;
  private stream: fs.WriteStream | null = null;
  private headers: string[];
  private clear: boolean;
  private nextId: number = 1;
  private seqFilePath: string;

  constructor(filePath: string, headers: string[], options?: { clear?: boolean }) {
    this.filePath = path.resolve(filePath);
    this.headers = headers;
    this.clear = !!(options?.clear);
    this.seqFilePath = `${this.filePath}.seq`;
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

    const exists = fs.existsSync(this.filePath);
    if (this.clear) {
      try { if (exists) await fs.promises.unlink(this.filePath); } catch {}
      try { await fs.promises.unlink(this.seqFilePath); } catch {}
      this.stream = fs.createWriteStream(this.filePath, { flags: 'w', encoding: 'utf8' });
      await this.writeLine(this.headers);
      this.nextId = 1;
    } else {
      if (exists) {
        this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
        // 既存のシーケンスファイルがあれば採用。なければ 1 から開始
        try {
          const seqText = await fs.promises.readFile(this.seqFilePath, 'utf8');
          const n = Number(String(seqText).trim());
          this.nextId = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
        } catch {
          this.nextId = 1;
        }
      } else {
        this.stream = fs.createWriteStream(this.filePath, { flags: 'w', encoding: 'utf8' });
        await this.writeLine(this.headers);
        this.nextId = 1;
      }
    }
    // 初期シーケンスを保存
    try { await fs.promises.writeFile(this.seqFilePath, String(this.nextId), 'utf8'); } catch {}
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
    const currentId = this.nextId;
    await this.appendRow([
      node.url,
      currentId,
      node.site,
      snapshotForAIJson,
      snapshotInMdJson,
      node.timestamp,
    ]);
    this.nextId = currentId + 1;
    try { await fs.promises.writeFile(this.seqFilePath, String(this.nextId), 'utf8'); } catch {}
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


