import { promises as fs } from 'fs';
import path from 'path';
import { formatToolError } from './util.js';

type TodoAction = 'addTask' | 'setDone' | 'editTask';

export type TodoToolActionInput = {
  action: TodoAction;
  texts?: string[];    // addTask 用、または editTask 用
  indexes?: number[];  // setDone / editTask 用（1-based）
};

type TodoBatchInput = { actions: TodoToolActionInput[] };

function normalizeTasks(list?: string[]): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => String(s ?? ''))
    .map((s) => s.replace(/\r?\n/g, ' ').trim())
    .filter((s) => s.length > 0);
}

async function readFileSafe(filePath: string): Promise<string> {
  try { return (await fs.readFile(filePath)).toString('utf-8'); } catch { return ''; }
}

async function writeFileSafe(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8');
}

function parseTaskLines(md: string): { line: string; index: number }[] {
  const lines = md.split(/\r?\n/);
  const out: { line: string; index: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // 「- [ ] タスク」形式 もしくは 「1. [ ] タスク」形式の行を検出
    if (/^\s*(?:-|\d+\.)\s*\[( |x|X)\]\s+/.test(line)) out.push({ line, index: i });
  }
  return out;
}

function renderTask(text: string, done: boolean): string {
  // 旧形式（互換保持用）。本ツールでは最終的に番号付きで再レンダリングします。
  return `- [${done ? 'x' : ' '}] ${text}`;
}

// 1行のタスクをパースして { done, text } を取得
function parseTaskLine(line: string): { done: boolean; text: string } | null {
  const m = /^\s*(?:-|(?<num>\d+)\.)\s*\[(?<mark> |x|X)\]\s+(?<text>.*)$/.exec(line);
  if (!m) return null;
  const mark = (m.groups?.mark ?? ' ').toLowerCase();
  const text = String(m.groups?.text ?? '').trim();
  return { done: mark === 'x', text };
}

type ParsedTask = { lineIndex: number; done: boolean; text: string };

function extractTasksWithPositions(md: string): ParsedTask[] {
  const lines = md.split(/\r?\n/);
  const out: ParsedTask[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!/^\s*(?:-|\d+\.)\s*\[( |x|X)\]\s+/.test(line)) continue;
    const parsed = parseTaskLine(line);
    if (parsed) out.push({ lineIndex: i, done: parsed.done, text: parsed.text });
  }
  return out;
}

function renderNumberedTasks(tasks: Array<{ done: boolean; text: string }>): string {
  const lines: string[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i]!;
    const n = i + 1;
    lines.push(`${n}. [${t.done ? 'x' : ' '}] ${t.text}`);
  }
  return lines.join('\n');
}

export async function todoTool(input: TodoBatchInput): Promise<string> {
  const filePath = path.resolve(process.cwd(), 'todo.md');
  const isBatch = Array.isArray((input as any)?.actions);
  try {
    let current = await readFileSafe(filePath);
    if (!current) {
      // 初回作成時はヘッダーなどは付けずにシンプルに開始
      await writeFileSafe(filePath, '');
      current = '';
    }

    async function doAddTask(inp: TodoToolActionInput): Promise<{ ok: true; added: string[] } | { ok: string }>{
      const list = normalizeTasks(inp.texts);
      if (!list.length) return { ok: 'エラー: addTask: texts が空です' };
      // 既存タスクを抽出
      const existing = extractTasksWithPositions(current).map((t) => ({ done: t.done, text: t.text }));
      const merged = existing.concat(list.map((t) => ({ done: false, text: t })));
      const nextRendered = renderNumberedTasks(merged);
      const next = nextRendered + (nextRendered.endsWith('\n') ? '' : '\n');
      await writeFileSafe(filePath, next);
      current = next;
      return { ok: true, added: list } as const;
    }

    async function doSetDone(inp: TodoToolActionInput): Promise<{ ok: true; indexes?: number[] } | { ok: string }>{
      const idxes = Array.isArray(inp.indexes) ? inp.indexes : [];
      if (!idxes.length) return { ok: 'エラー: setDone: indexes が空です' };
      const tasks = extractTasksWithPositions(current);
      if (!tasks.length) return { ok: 'エラー: setDone: タスク行が見つかりません' };

      const total = tasks.length;
      const invalid: number[] = [];
      const already: number[] = [];
      for (const idxRaw of idxes) {
        const idx = Math.trunc(Number(idxRaw || 0));
        if (idx <= 0 || idx > total) { invalid.push(idxRaw as number); continue; }
        if (tasks[idx - 1]!.done) already.push(idx);
      }
      if (invalid.length || already.length) {
        const parts: string[] = [];
        if (invalid.length) parts.push(`不正な index: [${invalid.join(', ')}]`);
        if (already.length) parts.push(`既に完了済み index: [${already.join(', ')}]`);
        return { ok: `エラー: setDone: ${parts.join(' / ')}（処理は中止されました）` };
      }

      const updated = tasks.map((t, i) => ({ done: t.done || idxes.includes(i + 1), text: t.text }));
      const nextRendered = renderNumberedTasks(updated);
      const written = nextRendered + (nextRendered.endsWith('\n') ? '' : '\n');
      await writeFileSafe(filePath, written);
      current = written;
      return { ok: true, indexes: idxes };
    }

    async function doEditTask(inp: TodoToolActionInput): Promise<{ ok: true; indexes?: number[]; texts?: string[] } | { ok: string }>{
      const idxes = Array.isArray(inp.indexes) ? inp.indexes : [];
      const texts = normalizeTasks(inp.texts);
      if (!idxes.length || !texts.length || idxes.length !== texts.length) return { ok: 'エラー: editTask: indexes/texts が不正です' };
      const tasks = extractTasksWithPositions(current);
      if (!tasks.length) return { ok: 'エラー: editTask: タスク行が見つかりません' };

      const total = tasks.length;
      const invalid: number[] = [];
      for (const idxRaw of idxes) {
        const idx = Math.trunc(Number(idxRaw || 0));
        if (idx <= 0 || idx > total) invalid.push(idxRaw as number);
      }
      if (invalid.length) {
        return { ok: `エラー: editTask: 不正な index: [${invalid.join(', ')}]（処理は中止されました）` };
      }

      const updated = tasks.map((t) => ({ done: t.done, text: t.text }));
      for (let i = 0; i < idxes.length; i += 1) {
        const idx = Math.trunc(Number(idxes[i] || 0));
        const newText = String(texts[i] ?? '').trim();
        // normalizeTasks により空文字は除外済みだが二重防御
        if (idx <= 0 || idx > total || !newText) {
          return { ok: 'エラー: editTask: indexes/texts が不正です（空文字または範囲外）' };
        }
        updated[idx - 1]!.text = newText;
      }

      const nextRendered = renderNumberedTasks(updated);
      const written = nextRendered + (nextRendered.endsWith('\n') ? '' : '\n');
      await writeFileSafe(filePath, written);
      current = written;
      return { ok: true, indexes: idxes, texts };
    }

    async function runOne(inp: TodoToolActionInput): Promise<any> {
      const a = String(inp?.action ?? '').trim() as TodoAction;
      if (a === 'addTask') return doAddTask(inp);
      if (a === 'setDone') return doSetDone(inp);
      if (a === 'editTask') return doEditTask(inp);
      return { ok: `エラー: 未知の action=${a}` };
    }

    if (isBatch) {
      const arr = Array.isArray((input as any).actions) ? (input as any).actions as TodoToolActionInput[] : [];
      const results: any[] = [];
      for (const step of arr) {
        try {
          results.push(await runOne(step));
        } catch (e: any) {
          results.push({ ok: formatToolError(e) });
        }
      }
      const content = await readFileSafe(filePath);
      return JSON.stringify({ ok: true, action: 'batch', results, todos: { path: 'todo.md', content } });
    }

    throw new Error('actions が未指定です');
  } catch (e: any) {
    const content = await readFileSafe(filePath);
    return JSON.stringify({ ok: formatToolError(e), action: 'batch', todos: { path: 'todo.md', content } });
  }
}


