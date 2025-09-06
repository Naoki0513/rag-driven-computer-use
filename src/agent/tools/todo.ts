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
    if (/^\s*- \[( |x|X)\] /.test(line)) out.push({ line, index: i });
  }
  return out;
}

function renderTask(text: string, done: boolean): string {
  return `- [${done ? 'x' : ' '}] ${text}`;
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
      const prefix = current.length && !current.endsWith('\n') ? current + '\n' : current;
      const appended = list.map((t) => renderTask(t, false)).join('\n');
      const next = prefix + appended + '\n';
      await writeFileSafe(filePath, next);
      current = next;
      return { ok: true, added: list } as const;
    }

    async function doSetDone(inp: TodoToolActionInput): Promise<{ ok: true; indexes?: number[] } | { ok: string }>{
      const lines = current.split(/\r?\n/);
      const tasks = parseTaskLines(current);
      if (!tasks.length) return { ok: 'エラー: setDone: タスク行が見つかりません' };
      const idxes = Array.isArray(inp.indexes) ? inp.indexes : [];
      const applied: number[] = [];
      for (const idxRaw of idxes) {
        const idx = Math.trunc(Number(idxRaw || 0));
        if (idx <= 0 || idx > tasks.length) continue;
        const t = tasks[idx - 1];
        if (!t) continue;
        const textPart = t.line.replace(/^\s*- \[( |x|X)\] /, '');
        lines[t.index] = renderTask(textPart, true);
        applied.push(idx);
      }
      const next = lines.join('\n');
      const written = next + (next.endsWith('\n') ? '' : '\n');
      await writeFileSafe(filePath, written);
      current = written;
      return { ok: true, indexes: applied };
    }

    async function doEditTask(inp: TodoToolActionInput): Promise<{ ok: true; indexes?: number[]; texts?: string[] } | { ok: string }>{
      const idxes = Array.isArray(inp.indexes) ? inp.indexes : [];
      const texts = normalizeTasks(inp.texts);
      if (!idxes.length || !texts.length || idxes.length !== texts.length) return { ok: 'エラー: editTask: indexes/texts が不正です' };
      const lines = current.split(/\r?\n/);
      const tasks = parseTaskLines(current);
      if (!tasks.length) return { ok: 'エラー: editTask: タスク行が見つかりません' };
      for (let i = 0; i < idxes.length; i += 1) {
        const idx = Math.trunc(Number(idxes[i] || 0));
        const newText = String(texts[i] ?? '').trim();
        if (!newText || idx <= 0 || idx > tasks.length) continue;
        const t = tasks[idx - 1];
        if (!t) continue;
        const isDone = /\[x\]/i.test(lines[t.index]!);
        lines[t.index] = renderTask(newText, isDone);
      }
      const next = lines.join('\n');
      const written = next + (next.endsWith('\n') ? '' : '\n');
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


