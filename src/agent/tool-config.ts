import { type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

export function buildToolConfig(): ToolConfiguration {
  return {
    tools: [
      {
        toolSpec: {
          name: 'browser_snapshot',
          description: '現在のページのスナップショット4AIを取得します（他ツールの後続検証や単体取得に使用）',
          inputSchema: {
            json: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        }
      },
      // keyword_search は上段で定義済み
      // run_query は下段に1つだけ定義します
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
          name: 'todo',
          description: 'エージェントの実行計画用のToDoを管理します（actions配列で一括指定）。操作後は常にtodo.mdの内容を返します。\n- addTask: texts(string[]) を渡します。例: {"actions":[{"action":"addTask","texts":["タスク1","タスク2"]}]}\n- setDone: indexes(number[]) を渡します。例: {"actions":[{"action":"setDone","indexes":[1,3]}]}\n- editTask: indexes(number[]) と texts(string[]) を同数で渡します。例: {"actions":[{"action":"editTask","indexes":[2],"texts":["新しい名前"]}]}',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                actions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      action: { type: 'string', enum: ['addTask', 'setDone', 'editTask'] },
                      texts: { type: 'array', items: { type: 'string' } },
                      indexes: { type: 'array', items: { type: 'number' } }
                    },
                    required: ['action']
                  }
                }
              },
              required: ['actions']
            }
          }
        }
      },
      {
        toolSpec: {
          name: 'browser_goto',
          description: '指定したURLまたはIDに基づき遷移します。IDが渡された場合はCSVからURLを解決して遷移（実行後のスナップショット返却）',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                id: { type: 'string', description: 'pages.id（文字列として受理）' },
                autoLogin: { type: 'boolean', description: 'true の場合、今回の goto でログイン試行する（未指定時は初回のみ自動）' }
              },
              required: [],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'run_query',
          description: 'DuckDBに対してSQLを実行します（CSV: pages ビューに対するクエリ）',
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
          name: 'url_search',
          description: '意味ベースのクエリ（語の意味・意図を強調）で Cohere Rerank 3.5 により候補を抽出します。返却は2種類のTop5: (1) URL列: {id,url} (2) snapshotin MD列(500文字チャンク): {id,url}。この結果を起点に、後続で run_query を用いて該当URLのスナップショット詳細を確認してください。',
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




