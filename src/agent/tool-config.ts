import { type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

export function buildToolConfig(): ToolConfiguration {
  return {
    tools: [
      {
        toolSpec: {
          name: 'browser_snapshot',
          description: '現在のページのスナップショット4AIを取得します。query（意味クエリ）に基づき、階層チャンク化+リランクで上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: []
            }
          }
        }
      },
      // run_query は下段に1つだけ定義します
      {
        toolSpec: {
          name: 'browser_flow',
          description: '現在のページ上で、クリック/入力/キー送信の複数操作(steps)を順次一括実行します。steps実行後、query（意味クエリ）に基づきスナップショットを階層チャンク化+リランクし、上位3件のチャンクのみ返却します（要素解決は ref→role+name→href のフォールバック）。',
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
                },
                query: { type: 'string', description: 'steps 実行後に何を探したいかを表す意味クエリ。これに基づき上位3チャンクを返却' }
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
          description: '指定したURLまたはIDに基づき遷移します。IDが渡された場合はCSVからURLを解決して遷移。遷移後、query（意味クエリ）に基づきスナップショットをチャンク分割+リランクし、上位3件のチャンクのみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                id: { type: 'string', description: 'pages.id（文字列として受理）' },
                autoLogin: { type: 'boolean', description: 'true の場合、今回の goto でログイン試行する（未指定時は初回のみ自動）' },
                query: { type: 'string', description: '遷移後に探したい要素/情報の意味クエリ。上位3チャンクを返却' }
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
          name: 'snapshot_search',
          description: '全ページの "snapshotfor AI" を一括取得し階層チャンク分割。keywordQuery(AND部分一致, 大文字小文字無視)でチャンクを絞り込み、rerankQueryでCohere Rerankにより意味で並べ替え、上位K件(未指定時は5件)の {id,url,chunk} を返します（リランク時のみURLもテキストに付加）。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                keywordQuery: { type: 'string', description: 'OR部分一致で使う小粒のキーワード（カンマ区切り）' },
                rerankQuery: { type: 'string', description: '意味重視で並べ替えるクエリ' },
                topK: { type: 'number', description: '返却する上位件数（未指定時は5、上限は環境設定に従う）' },
              },
              required: ['keywordQuery', 'rerankQuery'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_login',
          description: 'ログイン先URLへ遷移し、環境変数の資格情報でログインします。ログイン後、query（意味クエリ）に基づきスナップショットをチャンク分割+リランクし、上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: { url: { type: 'string' }, query: { type: 'string' } },
              required: ['url'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_click',
          description: 'ref(eXX) で特定した要素をクリックします。クリック後、query（意味クエリ）に基づきスナップショットをチャンク分割+リランクし、上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' }, query: { type: 'string' } },
              required: ['ref'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_input',
          description: 'ref(eXX) で特定した要素にテキストを入力します。入力後、query（意味クエリ）に基づきスナップショットをチャンク分割+リランクし、上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' }, text: { type: 'string' }, query: { type: 'string' } },
              required: ['ref', 'text'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_press',
          description: 'ref(eXX) で特定した要素に対してキーボード押下を送ります。送信後、query（意味クエリ）に基づきスナップショットをチャンク分割+リランクし、上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: { ref: { type: 'string' }, key: { type: 'string' }, query: { type: 'string' } },
              required: ['ref', 'key'],
            },
          },
        },
      },
    ],
  } as ToolConfiguration;
}




