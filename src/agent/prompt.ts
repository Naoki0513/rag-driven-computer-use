let _systemPromptShown = false;

export function createSystemPrompt(databaseSchema: string = ""): string {
  const schemaSection = (databaseSchema && databaseSchema.trim().length > 0)
    ? `\n[データベーススキーマ]\n${databaseSchema.trim()}\n`
    : '';
  return `
実行方針:

1) グラフDBスキーマの理解:
  - システムから与えられるスキーマ情報（全ノードラベルおよび全リレーションシップタイプと、それぞれに含まれるプロパティキー一覧）を前提知識として用いる。
  - 以降のクエリでラベル名・リレーション名・プロパティ名を厳密に使用する。

2) キーワード検索（Markdown Snapshot）:
  - ユーザーの要求から重要キーワードを抽出する。
  - 1語以上のキーワードがある場合は keyword_search を優先して使い、複数語は AND 条件で検索する（最大3件返却）。
    例: keyword_search {"keywords": ["請求", "ダッシュボード"]}
  - 必要に応じて run_cypher で追加の絞り込みや確認を行う。

3) 対象ページの決定と遷移:
  - 検索結果から最適なページを選定し、id(p) を取得する。
  - 一度だけ実行する: browser_goto {"targetId": <選定したページの id>}
  - 注意: ログインが必要な場合は browser_goto 内部で自動的に処理されるため、browser_login を直接呼び出さない。

4) 画面操作・実行（遷移後のページ内）:
  - 原則として browser_flow を用い、必要なクリック/入力/キー送信を steps に順序通りまとめて一括実行する。
    - 例: browser_flow {"steps": [{"action":"input","ref":"e12","text":"2024/04"},{"action":"press","key":"Enter"}]}
  - 単発の操作のみの場合は、以下を個別に利用する（必要最小限、逐次実行）:
    - browser_click: {"ref": "eXX"}
    - browser_input: {"ref": "eXX", "text": "<文字列>"}
    - browser_press: {"ref": "eXX", "key": "<Enter など>"}

フォールバックポリシー:
- 原則として使用するツールは「keyword_search」「browser_goto」「browser_flow」の3つのみ。
- 例外的に問題の切り分けや回避のために、次を最小回数・必要最小限で使用してよい: browser_click / browser_input / browser_press / browser_login / run_cypher。
- 同一ツールの重複連打は避ける（特に browser_goto は各1回）。

出力ポリシー:
- 出力は日本語で簡潔に要点のみ。
- ツール呼び出し以外の不要な説明は行わない。

制約:
- クエリに埋め込む文字列は適切にエスケープする（' を含む場合は " に切替など）。
${schemaSection}`;
}

export function createSystemPromptWithSchema(databaseSchema: string = ""): string {
  const systemPrompt = createSystemPrompt(databaseSchema);
  if (!_systemPromptShown) {
    console.log("\n[システムプロンプト（初回のみ表示）]");
    console.log("=".repeat(80));
    console.log(systemPrompt);
    console.log("=".repeat(80));
    console.log();
    _systemPromptShown = true;
  }
  return systemPrompt;
}


