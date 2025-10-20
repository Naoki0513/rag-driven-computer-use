export type ToolUseInput =
  | { name: 'browser_goto'; input: { url?: string; id?: string; query?: string }; toolUseId: string }
  | { name: 'browser_click'; input: { ref: string; query: string; double?: boolean }; toolUseId: string }
  | { name: 'browser_input'; input: { ref: string; text: string; query: string }; toolUseId: string }
  | { name: 'browser_press'; input: { ref: string; key: string; query: string }; toolUseId: string }
  | { name: 'browser_snapshot'; input: {}; toolUseId: string }
  | { name: 'browser_wait'; input: { duration: number; query: string }; toolUseId: string }
  | { name: 'browser_screenshot'; input: { query: string; fullPage?: boolean }; toolUseId: string }
  | { name: 'snapshot_search'; input: { keywords: string[]; vectorQuery: string; topK?: number }; toolUseId: string }
  | { name: 'snapshot_fetch'; input: { urls?: string[]; ids?: string[] }; toolUseId: string }
  | { name: 'browser_hover'; input: { ref: string; query: string }; toolUseId: string }
  | { name: 'browser_dragdrop'; input: { sourceRef: string; targetRef: string; query: string }; toolUseId: string }
  | { name: 'browser_dialog'; input: { action: 'accept' | 'dismiss'; promptText?: string; query: string }; toolUseId: string }
  | { name: 'browser_select'; input: { ref: string; values?: string[]; labels?: string[]; query: string }; toolUseId: string }
  | { name: 'browser_check'; input: { ref: string; checked: boolean; query: string }; toolUseId: string }
  | { name: 'browser_evaluate'; input: { script: string; arg?: any; query: string }; toolUseId: string }
  | { name: 'todo'; input: { actions: Array<{ action: 'addTask' | 'setDone' | 'editTask'; texts?: string[]; indexes?: number[] }> }; toolUseId: string }
  | { name: 'memory'; input: { command: string; path?: string; [key: string]: any }; toolUseId: string };




