import { type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

export function buildToolConfig(): ToolConfiguration {
  return {
    tools: [
      {
        toolSpec: {
          name: 'browser_flow',
          description: '現在のページ上で、クリック/入力/キー送信の複数操作(steps)を順次一括実行します（要素解決は ref→role+name→href のフォールバック、実行後スナップショット返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      action: { type: 'string', enum: ['click', 'input', 'press'] },
                      ref: { type: 'string' },
                      role: { type: 'string' },
                      name: { type: 'string' },
                      href: { type: 'string' },
                      text: { type: 'string' },
                      key: { type: 'string' }
                    },
                    required: ['action']
                  }
                }
              },
              required: ['steps']
            }
          }
        }
      },
      {
        toolSpec: {
          name: 'browser_goto',
          description: '内部ID(id(n))で指定したPageに、NAVIGATE_TO→CLICK_TO最短経路で到達します（実行後のスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { targetId: { type: 'number' } },
              required: ['targetId'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'run_cypher',
          description: 'Neo4jデータベースに対してCypherクエリを実行します',
          inputSchema: {
            json: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'keyword_search',
          description: '各ページの Markdown テキスト(snapshot_in_md)に対して、与えた keywords の全語を AND 条件で検索し、関連しそうな Page を最大3件返します（id(p), snapshot_in_md, depth, url）。到達したいページを見つけて id を取得するためのツールです。',
          inputSchema: {
            json: {
              type: 'object',
              properties: { keywords: { type: 'array', items: { type: 'string' } } },
              required: ['keywords'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_login',
          description: 'ログイン先URLへ遷移し、環境変数の資格情報でログインします（実行後のテキストスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_click',
          description: 'ref(eXX) で特定した要素をクリックします（実行後のテキストスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' } },
              required: ['ref'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_input',
          description: 'ref(eXX) で特定した要素にテキストを入力します（実行後のテキストスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' }, text: { type: 'string' } },
              required: ['ref', 'text'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_press',
          description: 'ref(eXX) で特定した要素に対してキーボード押下を送ります（実行後のテキストスナップショットを返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' }, key: { type: 'string' } },
              required: ['ref', 'key'],
            },
          },
        },
      },
    ],
    toolChoice: { auto: {} },
  } as ToolConfiguration;
}




