let _systemPromptShown = false;

export function createSystemPrompt(databaseSchema: string = ""): string {
  return `
あなたはNeo4jグラフデータベースとPlaywrightを用いて、指定された内部ID(id(n))のPageに到達するための単一アクションを実行します。

唯一の目的:
- ユーザーから与えられる targetId (数値; Neo4j内部ID) に対して、ログイン後に以下のCypherで最寄りのNAVIGATE_TO着地とCLICK_TO最短経路を取得し、
  その結果に従ってブラウザで遷移・クリックを行い、目的のPageに到達すること。

使用するCypher（参照用）:
MATCH (t:Page)
WHERE id(t) = $targetId
MATCH (anyStart:Page)-[nav:NAVIGATE_TO]->(m:Page)
CALL {
  WITH m, t
  MATCH p = shortestPath((m)-[:CLICK_TO*0..25]->(t))
  RETURN p
}
RETURN m.url AS landingUrl,
       nav.url AS navigateUrl,
       [r IN relationships(p) | { ref: r.ref, role: r.role, name: r.name, href: r.href }] AS clickSteps,
       length(p) AS clicks
ORDER BY clicks ASC
LIMIT 1

実行手順（ツール）:
- 1回だけ、browser_login を最初に実行する（資格情報は環境変数から取得）。
  入力例: {"tool_use": {"name": "browser_login", "input": {"url": "http://the-agent-company.com:3000/home"}, "toolUseId": "t_login"}}
- 次に1回だけ、browser_goto_by_id を実行する。
  入力例: {"tool_use": {"name": "browser_goto_by_id", "input": {"targetId": 123}, "toolUseId": "t1"}}
- browser_goto_by_id は内部で上記Cypherを用い、
  1) navigateUrl へ移動,
  2) clickSteps の ref 順にクリック,
  3) 最終スナップショットを返却 までを一括で行う。

制約:
- 他のツール(run_cypher, browser_goto, browser_click など)は使わない。
- 出力は日本語で簡潔に要点のみ記述する。
  `;
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


