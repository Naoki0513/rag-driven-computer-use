export type ToolUseInput =
  | { name: 'run_query'; input: { query: string }; toolUseId: string }
  | { name: 'browser_login'; input: { url: string }; toolUseId: string }
  | { name: 'browser_goto'; input: { url?: string; id?: string; autoLogin?: boolean }; toolUseId: string }
  | { name: 'browser_click'; input: { ref: string }; toolUseId: string }
  | { name: 'browser_input'; input: { ref: string; text: string }; toolUseId: string }
  | { name: 'browser_press'; input: { ref: string; key: string }; toolUseId: string }
  | { name: 'browser_snapshot'; input: {}; toolUseId: string }
  | { name: 'url_search'; input: { query: string }; toolUseId: string }
  | { name: 'snapshot_search'; input: { ids?: string[]; urls?: string[]; query: string }; toolUseId: string }
  | { name: 'todo'; input: { actions: Array<{ action: 'addTask' | 'setDone' | 'editTask'; texts?: string[]; indexes?: number[] }> }; toolUseId: string }
  | {
      name: 'browser_flow';
      input: {
        steps: Array<{
          action: 'click' | 'input' | 'press';
          ref?: string;
          role?: string;
          name?: string;
          href?: string;
          text?: string;
          key?: string;
        }>;
      };
      toolUseId: string;
    };




