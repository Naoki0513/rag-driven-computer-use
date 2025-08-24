export type ToolUseInput =
  | { name: 'run_cypher'; input: { query: string }; toolUseId: string }
  | { name: 'browser_login'; input: { url: string }; toolUseId: string }
  | { name: 'browser_goto'; input: { url: string }; toolUseId: string }
  | { name: 'browser_goto_by_id'; input: { targetId: number }; toolUseId: string }
  | { name: 'browser_click'; input: { ref: string }; toolUseId: string }
  | { name: 'browser_input'; input: { ref: string; text: string }; toolUseId: string }
  | { name: 'browser_press'; input: { ref: string; key: string }; toolUseId: string };




