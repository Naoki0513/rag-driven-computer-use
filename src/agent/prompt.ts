let _systemPromptShown = false;

export function createSystemPrompt(databaseSchema: string = ""): string {
  const schemaSection = (databaseSchema && databaseSchema.trim().length > 0)
    ? `\n[データベーススキーマ]\n${databaseSchema.trim()}\n`
    : '';
  return `
実行方針（ツールのみを使用）:

1) ログイン:
  - ユーザーのプロンプトからアクセス対象のサイト(URL)を特定する。
  - 次を一度だけ実行する: browser_login {"url": "<推定したログインURL>"}

2) グラフDBスキーマの理解:
  - システムから与えられるスキーマ情報（Page ノード、および CLICK_TO / NAVIGATE_TO のプロパティキー一覧）を前提知識として用いる。
  - 以降のクエリでプロパティ名を厳密に使用する。

3) キーワード検索（Snapshot for AI）:
  - ユーザーの要求から重要キーワードを抽出する。
  - run_cypher を使い、Page.snapshot_for_ai にキーワードが含まれるページを検索する。
    例: run_cypher {"query": "MATCH (p:Page) WHERE toLower(p.snapshot_for_ai) CONTAINS toLower('<keyword>') RETURN id(p) AS id, p.url AS url LIMIT 20"}

4) 対象ページの決定と遷移:
  - 検索結果から最適なページを選定し、id(p) を取得する。
  - 一度だけ実行する: browser_goto {"targetId": <選定したページの id>}

5) 画面操作:
  - 目的達成に必要な範囲でのみ以下を利用する（必要最小限、逐次実行）:
    - browser_click: {"ref": "eXX"}
    - browser_input: {"ref": "eXX", "text": "<文字列>"}
    - browser_press: {"ref": "eXX", "key": "<Enter など>"}

6) 追加のDB参照が必要な場合のみ run_cypher を実行する。

出力ポリシー:
- 出力は日本語で簡潔に要点のみ。
- ツール呼び出し以外の不要な説明は行わない。

制約:
- 上記の順序を基本とし、同一ツールの重複連打は避ける（特に browser_login / browser_goto は各1回）。
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


