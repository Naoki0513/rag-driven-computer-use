import { promises as fs } from 'fs';
import path from 'path';
import { formatToolError } from './util.js';

// メモリディレクトリのルートパス
const MEMORY_ROOT = path.resolve(process.cwd(), 'memories');

type MemoryCommand = 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename';

type MemoryInput = {
  command: MemoryCommand;
  path?: string;
  old_path?: string;
  new_path?: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  view_range?: [number, number];
};

/**
 * パストラバーサル攻撃を防ぐためのパス検証
 * /memories ディレクトリ内のパスであることを保証する
 */
function validatePath(inputPath: string): { valid: boolean; resolvedPath: string; error?: string } {
  try {
    // 入力パスを正規化
    let normalized = path.normalize(inputPath);
    
    // /memories/ で始まる場合は、その部分を削除して相対パスとして扱う
    if (normalized.startsWith('/memories/')) {
      normalized = normalized.substring(10); // '/memories/' の10文字を削除
    } else if (normalized === '/memories') {
      normalized = '.'; // ルートディレクトリ自体を指す場合
    }
    
    // 相対パスを絶対パスに解決
    const resolved = path.resolve(MEMORY_ROOT, normalized);
    
    // MEMORY_ROOT配下であることを確認
    const relative = path.relative(MEMORY_ROOT, resolved);
    
    // ../ を含む場合は不正なパス
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return {
        valid: false,
        resolvedPath: '',
        error: `Security error: Path must be within /memories directory: ${inputPath}`
      };
    }
    
    return { valid: true, resolvedPath: resolved };
  } catch (e: any) {
    return {
      valid: false,
      resolvedPath: '',
      error: `Path validation error: ${String(e?.message ?? e)}`
    };
  }
}

/**
 * ディレクトリの内容を表示
 */
async function viewDirectory(dirPath: string): Promise<string> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    if (entries.length === 0) {
      return `Directory: ${dirPath}\n(empty)`;
    }
    
    const lines: string[] = [`Directory: ${dirPath}`];
    for (const entry of entries) {
      const prefix = entry.isDirectory() ? '📁 ' : '📄 ';
      lines.push(`${prefix}${entry.name}`);
    }
    return lines.join('\n');
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return `Directory: ${dirPath}\n(does not exist yet)`;
    }
    throw e;
  }
}

/**
 * ファイルの内容を表示（オプションで行範囲指定）
 */
async function viewFile(filePath: string, viewRange?: [number, number]): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    if (viewRange && Array.isArray(viewRange) && viewRange.length === 2) {
      const [start, end] = viewRange;
      const startLine = Math.max(1, Math.min(start, lines.length));
      const endLine = Math.max(startLine, Math.min(end, lines.length));
      
      const selectedLines = lines.slice(startLine - 1, endLine);
      return `File: ${filePath} (lines ${startLine}-${endLine}/${lines.length})\n${selectedLines.join('\n')}`;
    }
    
    return `File: ${filePath} (${lines.length} lines)\n${content}`;
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw e;
  }
}

/**
 * ファイルを作成または上書き
 */
async function createFile(filePath: string, fileText: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, fileText, 'utf-8');
  const lines = fileText.split('\n').length;
  return `✓ File created: ${filePath} (${lines} lines)`;
}

/**
 * ファイル内の文字列を置換
 */
async function strReplace(filePath: string, oldStr: string, newStr: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  
  if (!content.includes(oldStr)) {
    throw new Error(`String not found: "${oldStr.substring(0, 50)}${oldStr.length > 50 ? '...' : ''}"`);
  }
  
  const occurrences = content.split(oldStr).length - 1;
  if (occurrences > 1) {
    throw new Error(`String found in multiple locations (${occurrences}). Please specify a more unique string.`);
  }
  
  const newContent = content.replace(oldStr, newStr);
  await fs.writeFile(filePath, newContent, 'utf-8');
  
  return `✓ String replaced: ${filePath}`;
}

/**
 * 指定行にテキストを挿入
 */
async function insertText(filePath: string, insertLine: number, insertText: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  
  const lineNum = Math.max(0, Math.min(insertLine, lines.length + 1));
  lines.splice(lineNum, 0, insertText);
  
  const newContent = lines.join('\n');
  await fs.writeFile(filePath, newContent, 'utf-8');
  
  return `✓ Text inserted: ${filePath} (line ${lineNum})`;
}

/**
 * ファイルまたはディレクトリを削除
 */
async function deletePath(targetPath: string): Promise<string> {
  try {
    const stat = await fs.stat(targetPath);
    
    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
      return `✓ Directory deleted: ${targetPath}`;
    } else {
      await fs.unlink(targetPath);
      return `✓ File deleted: ${targetPath}`;
    }
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      throw new Error(`Target not found: ${targetPath}`);
    }
    throw e;
  }
}

/**
 * ファイルまたはディレクトリをリネーム/移動
 */
async function renamePath(oldPath: string, newPath: string): Promise<string> {
  try {
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.rename(oldPath, newPath);
    return `✓ Renamed/moved: ${oldPath} → ${newPath}`;
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      throw new Error(`Source not found: ${oldPath}`);
    }
    throw e;
  }
}

/**
 * メモリツールのメイン処理
 */
export async function memoryTool(input: MemoryInput): Promise<string> {
  try {
    const command = String(input?.command ?? '').trim() as MemoryCommand;
    
    if (!command) {
      return JSON.stringify({ 
        ok: false, 
        action: 'memory', 
        error: 'Error: command is required (view, create, str_replace, insert, delete, rename)' 
      });
    }
    
    // メモリディレクトリが存在しない場合は作成
    try {
      await fs.mkdir(MEMORY_ROOT, { recursive: true });
    } catch {}
    
    switch (command) {
      case 'view': {
        const inputPath = String(input?.path ?? '/memories').trim();
        const validation = validatePath(inputPath);
        
        if (!validation.valid) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: validation.error });
        }
        
        try {
          const stat = await fs.stat(validation.resolvedPath);
          let result: string;
          
          if (stat.isDirectory()) {
            result = await viewDirectory(validation.resolvedPath);
          } else {
            result = await viewFile(validation.resolvedPath, input.view_range);
          }
          
          return JSON.stringify({ ok: true, action: 'memory', command, result });
        } catch (e: any) {
          if (e.code === 'ENOENT') {
            // パスが存在しない場合は空のディレクトリとして表示
            return JSON.stringify({ 
              ok: true, 
              action: 'memory', 
              command, 
              result: `Directory: ${validation.resolvedPath}\n(does not exist yet)` 
            });
          }
          throw e;
        }
      }
      
      case 'create': {
        const inputPath = String(input?.path ?? '').trim();
        const fileText = String(input?.file_text ?? '');
        
        if (!inputPath) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: 'Error: path is required' });
        }
        
        const validation = validatePath(inputPath);
        if (!validation.valid) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: validation.error });
        }
        
        const result = await createFile(validation.resolvedPath, fileText);
        return JSON.stringify({ ok: true, action: 'memory', command, result });
      }
      
      case 'str_replace': {
        const inputPath = String(input?.path ?? '').trim();
        const oldStr = String(input?.old_str ?? '');
        const newStr = String(input?.new_str ?? '');
        
        if (!inputPath || !oldStr) {
          return JSON.stringify({ 
            ok: false, 
            action: 'memory', 
            command, 
            error: 'Error: path and old_str are required' 
          });
        }
        
        const validation = validatePath(inputPath);
        if (!validation.valid) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: validation.error });
        }
        
        const result = await strReplace(validation.resolvedPath, oldStr, newStr);
        return JSON.stringify({ ok: true, action: 'memory', command, result });
      }
      
      case 'insert': {
        const inputPath = String(input?.path ?? '').trim();
        const insertLine = Number(input?.insert_line ?? 0);
        const insertTextContent = String(input?.insert_text ?? '');
        
        if (!inputPath || !insertTextContent) {
          return JSON.stringify({ 
            ok: false, 
            action: 'memory', 
            command, 
            error: 'Error: path and insert_text are required' 
          });
        }
        
        const validation = validatePath(inputPath);
        if (!validation.valid) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: validation.error });
        }
        
        const result = await insertText(validation.resolvedPath, insertLine, insertTextContent);
        return JSON.stringify({ ok: true, action: 'memory', command, result });
      }
      
      case 'delete': {
        const inputPath = String(input?.path ?? '').trim();
        
        if (!inputPath) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: 'Error: path is required' });
        }
        
        // /memories ルート自体の削除は禁止
        if (inputPath === '/memories' || inputPath === 'memories') {
          return JSON.stringify({ 
            ok: false, 
            action: 'memory', 
            command, 
            error: 'Error: Cannot delete /memories root directory' 
          });
        }
        
        const validation = validatePath(inputPath);
        if (!validation.valid) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: validation.error });
        }
        
        const result = await deletePath(validation.resolvedPath);
        return JSON.stringify({ ok: true, action: 'memory', command, result });
      }
      
      case 'rename': {
        const oldPath = String(input?.old_path ?? '').trim();
        const newPath = String(input?.new_path ?? '').trim();
        
        if (!oldPath || !newPath) {
          return JSON.stringify({ 
            ok: false, 
            action: 'memory', 
            command, 
            error: 'Error: old_path and new_path are required' 
          });
        }
        
        const oldValidation = validatePath(oldPath);
        if (!oldValidation.valid) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: oldValidation.error });
        }
        
        const newValidation = validatePath(newPath);
        if (!newValidation.valid) {
          return JSON.stringify({ ok: false, action: 'memory', command, error: newValidation.error });
        }
        
        const result = await renamePath(oldValidation.resolvedPath, newValidation.resolvedPath);
        return JSON.stringify({ ok: true, action: 'memory', command, result });
      }
      
      default:
        return JSON.stringify({ 
          ok: false, 
          action: 'memory', 
          error: `Error: Unknown command: ${command} (must be one of: view, create, str_replace, insert, delete, rename)` 
        });
    }
  } catch (e: any) {
    return JSON.stringify({ 
      ok: false, 
      action: 'memory', 
      command: input?.command, 
      error: formatToolError(e) 
    });
  }
}

