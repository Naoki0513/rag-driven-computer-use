import { type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

export function buildToolConfig(): ToolConfiguration {
  return {
    tools: [
      {
        toolSpec: {
          name: 'browser_snapshot',
          description: '現在のページのsnapshotforaiを取得します。ブラウザースナップショットのみ、リランクせずページ全体のスナップショット本文をそのまま返却します（snapshots.text）。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {},
              required: []
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
          name: 'snapshot_search',
          description: '全ページの "snapshotforai" を一括取得し階層チャンク分割。keywordQuery(AND部分一致, 大文字小文字無視)でチャンクを絞り込み、rerankQueryでCohere Rerankにより意味で並べ替え、上位K件(未指定時は5件)の {id,url,chunk} を返します（リランク時のみURLもテキストに付加）。',
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
          name: 'snapshot_fetch',
          description: 'CSVからURLまたはIDを指定してページのsnapshotforaiの完全なテキストを取得します。snapshot_searchで取得したチャンク結果からページ全文を確認したい場合に使用します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                urls: { type: 'array', items: { type: 'string' }, description: '取得したいページのURLリスト' },
                ids: { type: 'array', items: { type: 'string' }, description: '取得したいページのIDリスト（文字列として指定）' },
              },
              required: [],
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
          description: '要素をクリックします。ref（必須）で要素を指定し、query（必須）でクリック後の確認内容を指定します。refはaria-refセレクターで解決され、失敗時は自動的にスナップショットから役割と名前を推定してフォールバックします。クリック後は query に基づきスナップショットをチャンク分割+リランクし、上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'スナップショット内の参照ID（例: e1, e2, f1e3 など）' },
                query: { type: 'string', description: 'クリック後に探したい要素/情報の意味クエリ。上位3チャンクを返却' }
              },
              required: ['ref', 'query'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_input',
          description: '要素にテキストを入力します。ref（必須）で要素を指定し、text（必須）で入力内容、query（必須）で入力後の確認内容を指定します。refはaria-refセレクターで解決され、失敗時は自動的にスナップショットから役割と名前を推定してフォールバックします。入力後は query に基づきスナップショットをチャンク分割+リランクし、上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'スナップショット内の参照ID（例: e1, e2, f1e3 など）' },
                text: { type: 'string', description: '入力するテキスト' },
                query: { type: 'string', description: '入力後に探したい要素/情報の意味クエリ。上位3チャンクを返却' }
              },
              required: ['ref', 'text', 'query'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_press',
          description: '要素にキーボード押下を送ります。ref（必須）で要素を指定し、key（必須）で押下するキー、query（必須）で送信後の確認内容を指定します。refはaria-refセレクターで解決され、失敗時は自動的にスナップショットから役割と名前を推定してフォールバックします。送信後は query に基づきスナップショットをチャンク分割+リランクし、上位3件のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'スナップショット内の参照ID（例: e1, e2, f1e3 など）' },
                key: { type: 'string', description: '押下するキー（例: Enter, Tab, Escape など）' },
                query: { type: 'string', description: '送信後に探したい要素/情報の意味クエリ。上位3チャンクを返却' }
              },
              required: ['ref', 'key', 'query'],
            },
          },
        },
      },
    ],
  } as ToolConfiguration;
}




