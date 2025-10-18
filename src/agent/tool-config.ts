import { type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

export function buildToolConfig(): ToolConfiguration {
  const isEn = String(process.env.AGENT_LANG || '').toLowerCase().startsWith('en');
  return {
    tools: [
      {
        toolSpec: {
          name: 'browser_snapshot',
          description: isEn
            ? 'Fetch snapshotforai for the current page. For browser snapshot only, return the full snapshot text (snapshots.text) without reranking.'
            : '現在のページのsnapshotforaiを取得します。ブラウザースナップショットのみ、リランクせずページ全体のスナップショット本文をそのまま返却します（snapshots.text）。',
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
          description: isEn
            ? 'Manage ToDos for the agent execution plan (batched via actions array). Always returns the current content of todo.md after operations.\n- addTask: pass texts(string[]). Example: {"actions":[{"action":"addTask","texts":["Task 1","Task 2"]}]}\n- setDone: pass indexes(number[]). Example: {"actions":[{"action":"setDone","indexes":[1,3]}]}\n- editTask: pass indexes(number[]) and texts(string[]) with the same length. Example: {"actions":[{"action":"editTask","indexes":[2],"texts":["New name"]}]}'
            : 'エージェントの実行計画用のToDoを管理します（actions配列で一括指定）。操作後は常にtodo.mdの内容を返します。\n- addTask: texts(string[]) を渡します。例: {"actions":[{"action":"addTask","texts":["タスク1","タスク2"]}]}\n- setDone: indexes(number[]) を渡します。例: {"actions":[{"action":"setDone","indexes":[1,3]}]}\n- editTask: indexes(number[]) と texts(string[]) を同数で渡します。例: {"actions":[{"action":"editTask","indexes":[2],"texts":["新しい名前"]}]}',
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
          name: 'memory',
          description: isEn
            ? 'Store and retrieve information across conversations through a memory file directory (/memories). Claude can create, read, update, and delete files that persist between sessions. IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE. As you work, record status/progress/thoughts in your memory. Supported commands: view (show directory or file), create (create/overwrite file), str_replace (replace text), insert (insert at line), delete (remove file/dir), rename (rename/move). All paths must be within /memories directory for security.'
            : 'メモリファイルディレクトリ (/memories) を通じて会話間で情報を保存・取得します。Claudeはセッション間で永続化されるファイルを作成、読み込み、更新、削除できます。重要: 他の操作をする前に必ずメモリディレクトリを確認してください。作業中は進捗状況や思考をメモリに記録します。サポートされているコマンド: view (ディレクトリまたはファイルの表示), create (ファイルの作成/上書き), str_replace (テキストの置換), insert (行への挿入), delete (ファイル/ディレクトリの削除), rename (名前変更/移動)。セキュリティのため、すべてのパスは /memories ディレクトリ内である必要があります。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                command: { 
                  type: 'string', 
                  enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
                  description: isEn ? 'Command to execute' : '実行するコマンド'
                },
                path: { 
                  type: 'string', 
                  description: isEn ? 'Path to file or directory (within /memories)' : 'ファイルまたはディレクトリのパス (/memories 内)'
                },
                old_path: { 
                  type: 'string', 
                  description: isEn ? 'Source path for rename command' : 'renameコマンドの元パス'
                },
                new_path: { 
                  type: 'string', 
                  description: isEn ? 'Destination path for rename command' : 'renameコマンドの先パス'
                },
                file_text: { 
                  type: 'string', 
                  description: isEn ? 'Full file content for create command' : 'createコマンドのファイル内容全体'
                },
                old_str: { 
                  type: 'string', 
                  description: isEn ? 'Text to find for str_replace command (must be unique)' : 'str_replaceコマンドで検索するテキスト（一意である必要あり）'
                },
                new_str: { 
                  type: 'string', 
                  description: isEn ? 'Replacement text for str_replace command' : 'str_replaceコマンドの置換後テキスト'
                },
                insert_line: { 
                  type: 'number', 
                  description: isEn ? 'Line number for insert command (0-based)' : 'insertコマンドの行番号（0始まり）'
                },
                insert_text: { 
                  type: 'string', 
                  description: isEn ? 'Text to insert for insert command' : 'insertコマンドで挿入するテキスト'
                },
                view_range: { 
                  type: 'array',
                  items: { type: 'number' },
                  description: isEn ? 'Optional [start_line, end_line] for view command' : 'viewコマンドの任意の行範囲 [開始行, 終了行]'
                }
              },
              required: ['command']
            }
          }
        }
      },
      {
        toolSpec: {
          name: 'browser_goto',
          description: isEn
            ? 'Navigate to the specified URL or resolve id→URL from CSV and navigate. Authentication is auto-handled when necessary (env credentials + storageState). After navigation, chunk + rerank the snapshot by query (semantic query) and return only the top-N chunks (configured via AGENT_BROWSER_TOP_K).'
            : '指定したURLまたはIDに基づき遷移します。IDが渡された場合はCSVからURLを解決して遷移。必要時のみ自動で認証（環境変数の資格情報＋storageState補填）を行い、遷移後は query（意味クエリ）に基づきスナップショットをチャンク分割+リランクし、上位Nチャンク（環境変数 AGENT_BROWSER_TOP_K により指定）のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                id: { type: 'string', description: isEn ? 'pages.id (accepted as string)' : 'pages.id（文字列として受理）' },
                query: { type: 'string', description: isEn ? 'Semantic query for what to find after navigation. Returns top-N chunks (AGENT_BROWSER_TOP_K).' : '遷移後に探したい要素/情報の意味クエリ。上位Nチャンク（AGENT_BROWSER_TOP_K）を返却' }
              },
              required: [],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_hover',
          description: isEn
            ? 'Hover an element. Requires ref and query. After hovering, chunk + rerank the snapshot by query and return top-N chunks.'
            : '要素にホバーします。ref（必須）と query（必須）。ホバー後は query に基づきスナップショットをチャンク分割+リランクし上位Nチャンクを返却します。',
          inputSchema: { json: { type: 'object', properties: { ref: { type: 'string' }, query: { type: 'string' } }, required: ['ref', 'query'] } }
        }
      },
      {
        toolSpec: {
          name: 'browser_dragdrop',
          description: isEn
            ? 'Perform drag & drop. Requires sourceRef, targetRef and query. After the action, rerank the snapshot by query and return results.'
            : 'ドラッグ&ドロップを実行します。sourceRef/targetRef（いずれも必須）と query（必須）。実行後は query に基づきスナップショットをリランクして返します。',
          inputSchema: { json: { type: 'object', properties: { sourceRef: { type: 'string' }, targetRef: { type: 'string' }, query: { type: 'string' } }, required: ['sourceRef', 'targetRef', 'query'] } }
        }
      },
      {
        toolSpec: {
          name: 'browser_dialog',
          description: isEn
            ? 'Handle a page dialog. action is accept|dismiss, optional promptText, and required query.'
            : 'ページのダイアログをハンドリングします。action は accept/dismiss、promptText 任意、query（必須）。',
          inputSchema: { json: { type: 'object', properties: { action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' }, query: { type: 'string' } }, required: ['action', 'query'] } }
        }
      },
      {
        toolSpec: {
          name: 'browser_select',
          description: isEn
            ? 'Select options of a select element. Requires ref, and either values(string[]) or labels(string[]), plus query.'
            : 'select 要素の選択肢を選びます。ref（必須）、values(string[]) または labels(string[]) のいずれか、query（必須）。',
          inputSchema: { json: { type: 'object', properties: { ref: { type: 'string' }, values: { type: 'array', items: { type: 'string' } }, labels: { type: 'array', items: { type: 'string' } }, query: { type: 'string' } }, required: ['ref', 'query'] } }
        }
      },
      {
        toolSpec: {
          name: 'browser_check',
          description: isEn
            ? 'Set the state of a checkbox/radio. Requires ref, checked(boolean), and query.'
            : 'チェックボックス/ラジオのチェック状態を変更します。ref（必須）、checked(boolean)、query（必須）。',
          inputSchema: { json: { type: 'object', properties: { ref: { type: 'string' }, checked: { type: 'boolean' }, query: { type: 'string' } }, required: ['ref', 'checked', 'query'] } }
        }
      },
      {
        toolSpec: {
          name: 'browser_evaluate',
          description: isEn
            ? 'Execute JavaScript in the page. Requires script(string), optional arg, and query. After execution, rerank the snapshot by query and return results.'
            : 'ブラウザページ内で JavaScript を実行します。script（必須、文字列）、arg（任意）、query（必須）。実行後は query に基づきスナップショットをリランクして返却します。',
          inputSchema: { json: { type: 'object', properties: { script: { type: 'string' }, arg: { }, query: { type: 'string' } }, required: ['script', 'query'] } }
        }
      },
      {
        toolSpec: {
          name: 'snapshot_search',
          description: isEn
            ? 'Perform advanced search using indexed chunks. Flow: 1) Load all pre-split chunks from Parquet 2) Filter chunks by AND match over keywords (case-insensitive) (e.g., {"keywords":["admin","orders","pending"]} matches chunks containing all terms) 3) Run vector search over the filtered chunks (fetch topK×10 results, default 100) 4) Rerank with Cohere to final topK (default 10) 5) Return {id,url,chunk}. Note: AGENT_INDEX_NAME and AGENT_INDEX_DIR must be set. If 0 results, reduce/generalize keywords and retry.'
            : 'インデックス化されたチャンクを使用した高度な検索を実行します。処理フロー: 1) Parquetファイルから事前分割済みチャンクを全件読み込み 2) keywords 配列（AND部分一致・小文字化して判定）でチャンクを絞り込み（例: {"keywords":["admin","orders","pending"]} は全語を含むチャンクのみ） 3) 絞り込まれたチャンクに対してベクトル検索を実行（topK×10件を取得、デフォルトは100件） 4) ベクトル検索結果をCohere Rerankで最終的にtopK件（デフォルトは10件）に絞り込み 5) 最終結果として {id,url,chunk} を返却。注意: AGENT_INDEX_NAMEとAGENT_INDEX_DIRの環境変数設定が必須です。キーワードが多すぎて0件の場合はキーワードを減らす/一般化するなど再試行してください。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                keywords: { type: 'array', items: { type: 'string' }, description: isEn ? 'Keywords (string[]) for AND substring match. Only chunks containing all keywords (case-insensitive).' : 'AND部分一致で使うキーワード配列。全てのキーワードを含むチャンクのみを抽出（小文字比較）' },
                vectorQuery: { type: 'string', description: isEn ? 'Semantic query used for vector search and reranking to get more relevant results.' : 'ベクトル検索とリランクで使用する意味クエリ。より意味的に関連性の高い結果を取得' },
                topK: { type: 'number', description: isEn ? 'Number of final top results to return (default 10). Vector search fetches 10× this before reranking.' : '最終的に返却する上位件数（未指定時は10件）。ベクトル検索ではこの10倍の件数を取得してからリランクで絞り込む' },
              },
              required: ['keywords', 'vectorQuery'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'snapshot_fetch',
          description: isEn
            ? 'Fetch the full snapshotforai from CSV by specifying URLs or IDs. Use when you need the entire page text after snapshot_search results.'
            : 'CSVからURLまたはIDを指定してページのsnapshotforaiの完全なテキストを取得します。snapshot_searchで取得したチャンク結果からページ全文を確認したい場合に使用します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                urls: { type: 'array', items: { type: 'string' }, description: isEn ? 'List of page URLs to fetch.' : '取得したいページのURLリスト' },
                ids: { type: 'array', items: { type: 'string' }, description: isEn ? 'List of page IDs to fetch (as strings).' : '取得したいページのIDリスト（文字列として指定）' },
              },
              required: [],
            },
          },
        },
      },
      
      {
        toolSpec: {
          name: 'browser_click',
          description: isEn
            ? 'Click/double-click an element. Requires ref and query; set double=true for double-click. Ref is resolved via aria-ref, with snapshot-based fallback. After the action, return top-N chunks based on query.'
            : '要素をクリック/ダブルクリックします。ref（必須）、query（必須）、double（任意: trueでダブルクリック）。refはaria-refで解決し、失敗時はスナップショットから推定します。実行後は query に基づき上位Nチャンクを返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: isEn ? 'Reference ID in snapshot (e.g., e1, e2, f1e3).' : 'スナップショット内の参照ID（例: e1, e2, f1e3 など）' },
                query: { type: 'string', description: isEn ? 'Semantic query to find information after clicking. Returns top-N chunks (AGENT_BROWSER_TOP_K).' : 'クリック後に探したい要素/情報の意味クエリ。上位Nチャンク（AGENT_BROWSER_TOP_K）を返却' },
                double: { type: 'boolean', description: isEn ? 'Set true to perform double-click.' : 'true の場合はダブルクリック' }
              },
              required: ['ref', 'query'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_input',
          description: isEn
            ? 'Type text into an element. Requires ref (target), text (input), and query (post-check). Ref is resolved via aria-ref with snapshot-based fallback. After input, chunk + rerank by query and return top-N chunks (AGENT_BROWSER_TOP_K).'
            : '要素にテキストを入力します。ref（必須）で要素を指定し、text（必須）で入力内容、query（必須）で入力後の確認内容を指定します。refはaria-refセレクターで解決され、失敗時は自動的にスナップショットから役割と名前を推定してフォールバックします。入力後は query に基づきスナップショットをチャンク分割+リランクし、上位Nチャンク（環境変数 AGENT_BROWSER_TOP_K により指定）のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: isEn ? 'Reference ID in snapshot (e.g., e1, e2, f1e3).' : 'スナップショット内の参照ID（例: e1, e2, f1e3 など）' },
                text: { type: 'string', description: isEn ? 'Text to input.' : '入力するテキスト' },
                query: { type: 'string', description: isEn ? 'Semantic query to verify after input. Returns top-N chunks (AGENT_BROWSER_TOP_K).' : '入力後に探したい要素/情報の意味クエリ。上位Nチャンク（AGENT_BROWSER_TOP_K）を返却' }
              },
              required: ['ref', 'text', 'query'],
            },
          },
        },
      },
      {
        toolSpec: {
          name: 'browser_press',
          description: isEn
            ? 'Send a key press to an element. Requires ref (target), key (to press), and query (post-check). Ref is resolved via aria-ref with snapshot-based fallback. After the action, chunk + rerank by query and return top-N chunks (AGENT_BROWSER_TOP_K).'
            : '要素にキーボード押下を送ります。ref（必須）で要素を指定し、key（必須）で押下するキー、query（必須）で送信後の確認内容を指定します。refはaria-refセレクターで解決され、失敗時は自動的にスナップショットから役割と名前を推定してフォールバックします。送信後は query に基づきスナップショットをチャンク分割+リランクし、上位Nチャンク（環境変数 AGENT_BROWSER_TOP_K により指定）のみ返却します。',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: isEn ? 'Reference ID in snapshot (e.g., e1, e2, f1e3).' : 'スナップショット内の参照ID（例: e1, e2, f1e3 など）' },
                key: { type: 'string', description: isEn ? 'Key to press (e.g., Enter, Tab, Escape).' : '押下するキー（例: Enter, Tab, Escape など）' },
                query: { type: 'string', description: isEn ? 'Semantic query to verify after sending the key. Returns top-N chunks (AGENT_BROWSER_TOP_K).' : '送信後に探したい要素/情報の意味クエリ。上位Nチャンク（AGENT_BROWSER_TOP_K）を返却' }
              },
              required: ['ref', 'key', 'query'],
            },
          },
        },
      },
    ],
  } as ToolConfiguration;
}




