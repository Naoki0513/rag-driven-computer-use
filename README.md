# WebGraph-Agent (TypeScript/Node.js)

Neo4jグラフデータベースに対して自然言語でクエリを実行できるAIエージェントと、Webアプリケーションの状態遷移をクロールする高度なツールセットです。

## 🎯 プロジェクト概要

WebGraph-Agentは2つの主要コンポーネントで構成されています：

1. **AIエージェント（メイン機能）**: Amazon BedrockとStrands Agents SDKを使用し、自然言語の質問からCypherクエリを自動生成・実行
2. **補助ツール群**: Webクローラーとデータベース診断ツールなど、データ収集と管理をサポート

このプロジェクトでは、Webアプリケーションの構造をグラフデータベースに保存し、AIを活用して直感的にデータを探索できます。

## 📋 必要な環境

### Neo4j
- URI: `bolt://localhost:7687`
- Web UI: `http://localhost:7474`
- ユーザー名: `neo4j`
- パスワード: `testpassword`

### Node.js / TypeScript
- Node.js 20以上（20.19以降推奨）
- npm 10以上

### AWS Bedrock（AIエージェント用）
- AWS アカウント
- Bedrock API アクセス権限
- Claude 3 Sonnet モデルへのアクセス権限

## セットアップ（Node.js/TypeScript 版）

### 1. リポジトリをクローン
```bash
git clone https://github.com/your-username/webgraph-demo.git
cd webgraph-demo
```

### 2. 依存インストール（Node）
```bash
npm install
npm run playwright:install   # 初回のみ（ブラウザをインストール）
```

### 3. 設定（.env）
`.env` を作成し、`.env.example` を参考に値を設定してください。

優先順位: CLI > .env > デフォルト。設定は .env に統一しています（Python の設定ファイルは使用しません）。

## 🚀 使い方

### 1. TypeScript クローラー

```bash
npm run typecheck
npm run build
npm run start:crawler
```

起動時ログに、初期ページのキャプチャ、ログイン判定、その後のBFSクロール進捗が表示されます。Neo4j未接続時は安全にスキップし、クローリングのみ実行します（結果はログ出力）。

対話例：
```
🚀 WebGraph-Agent Cypher AI エージェントを起動しています...
✅ Neo4jに接続しました: bolt://localhost:7687
✅ AIエージェントを初期化しました

📊 Neo4jグラフデータベースのクエリエージェントです
自然言語で質問してください（例: 「ノード数を教えて」「チャンネル一覧を表示」）
終了するには 'quit' または 'exit' と入力してください

👤 あなた: ノード数を教えて
🤖 エージェント: データベース内のノード総数は523個です。

👤 あなた: 状態の種類ごとに集計して
🤖 エージェント: 状態タイプごとの集計結果です：
- channel: 215個
- home: 45個
- thread: 125個
- dm: 89個
- settings: 35個
- profile: 14個
```

### 2. 補助ツール

#### 実行方法（エージェント）
```bash
npm run build
npm run start:agent -- "ノード数を教えて"
# または環境変数を利用
setx AGENT_QUERY "状態の種類ごとに集計して"
npm run start:agent
```

#### Neo4j接続診断
```bash
# cypher-shell を使って疎通確認
./cypher-shell.bat "RETURN 1 AS ok"
```

## 🌟 プロジェクトの特徴

### AIエージェントの機能
- **自然言語理解**: 日本語での質問を理解し、適切なCypherクエリを自動生成
- **コンテキスト認識**: データベーススキーマを自動的に把握し、最適なクエリを提案
- **エラー処理**: クエリエラーを検出し、修正案を提示
- **結果の説明**: クエリ結果を分かりやすい日本語で説明

### 補助ツールの機能
- **高速並列クロール**: 複数のブラウザインスタンスで並列処理
- **状態管理**: ページの完全な状態（HTML、ARIA情報）をキャプチャ
- **インタラクション記録**: クリック、ナビゲーションなどのアクションを記録
- **認証対応**: ログインが必要なサイトもサポート

### クロールの仕組み
1. 指定されたURLから開始
2. ページの状態（URL、タイトル、HTML、ARIAスナップショット）をキャプチャ
3. クリック可能な要素（ボタン、リンク、タブなど）を自動検出
4. 各要素をクリックまたはナビゲートして新しい状態を発見
5. BFS（幅優先探索）アルゴリズムで効率的に探索
6. 並列処理により高速にクロール
7. 状態と遷移情報をNeo4jに保存

## 📊 データ構造

### Stateノード
- `hash`: 状態の一意識別子
- `url`: ページのURL
- `title`: ページタイトル
- `state_type`: 状態のタイプ（home, channel, dm, thread, modal, settings, profile, page）
- `html`: ページのHTML（サイズ制限あり）
- `aria_snapshot`: ARIAスナップショット（アクセシビリティ情報）
- `timestamp`: キャプチャ日時

### TRANSITIONリレーション
- 状態間の遷移を表現
- `action_type`: アクションタイプ（click, navigate）
- `element_selector`: クリックした要素のセレクタ
- `element_text`: クリックした要素のテキスト
- `aria_context`: ARIA情報のコンテキスト
- 方向性あり（FROM → TO）

## 🔍 データの確認

### Neo4j Web UIでの確認
1. http://localhost:7474 にアクセス
2. ログイン（neo4j / testpassword）
3. 以下のクエリを実行：

```cypher
# すべての状態と遷移を表示
MATCH (s1:State)-[t:TRANSITION]->(s2:State) RETURN s1,t,s2

# 状態数を確認
MATCH (s:State) RETURN count(s) as stateCount

# 遷移数を確認
MATCH ()-[t:TRANSITION]->() RETURN count(t) as transitionCount

# 特定URLを含む状態を検索
MATCH (s:State) WHERE s.url CONTAINS 'example' RETURN s

# 最も多く遷移先となっている状態
MATCH (s:State)<-[t:TRANSITION]-(other)
RETURN s.url, s.state_type, count(other) as inbound_transitions
ORDER BY inbound_transitions DESC
LIMIT 10

# クリック要素ごとの遷移を集計
MATCH ()-[t:TRANSITION]->()
RETURN t.element_text, t.element_selector, count(*) as click_count
ORDER BY click_count DESC
LIMIT 20
```

## ⚙️ 設定

### .env のキー一覧（抜粋）

```env
# エージェント（Bedrock + Neo4j）
AGENT_AWS_REGION=us-west-2
AGENT_BEDROCK_MODEL_ID=us.anthropic.claude-3-7-sonnet-20250219-v1:0
AGENT_NEO4J_URI=bolt://localhost:7687
AGENT_NEO4J_USER=neo4j
AGENT_NEO4J_PASSWORD=testpassword

# クローラ
CRAWLER_NEO4J_URI=bolt://localhost:7687
CRAWLER_NEO4J_USER=neo4j
CRAWLER_NEO4J_PASSWORD=testpassword
CRAWLER_TARGET_URL=http://the-agent-company.com:3000/
CRAWLER_LOGIN_USER=theagentcompany
CRAWLER_LOGIN_PASS=theagentcompany
CRAWLER_MAX_STATES=10000
CRAWLER_MAX_DEPTH=20
CRAWLER_PARALLEL_TASKS=8
CRAWLER_HEADFUL=false
CRAWLER_CLEAR_DB=true
CRAWLER_EXHAUSTIVE=false
```

## ⚠️ 注意事項

- 対象サイトの利用規約を確認してください
- 大規模なサイトをクロールする場合は、サーバーへの負荷に注意してください
- robots.txtの規約を尊重してください
- 必要に応じてクロール間隔を調整してください

## 🛠️ トラブルシューティング

### AIエージェント関連

#### AWS認証エラー
- AWS認証情報が正しく設定されているか確認（AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEYなどの環境変数）
- AWS CLIがインストールされている場合は `aws configure` で設定確認
- Bedrockへのアクセス権限があるか確認

#### Bedrock APIエラー
- リージョンが正しいか確認（Claude 3 Sonnetが利用可能なリージョン）
- モデルIDが正しいか確認
- APIクォータを超えていないか確認

### Neo4j接続エラー
- Neo4jが起動していることを確認
- 接続情報（URI、ユーザー名、パスワード）を確認
  - `./cypher-shell.bat "RETURN 1 AS ok"` で疎通確認

### クロール関連
- ネットワーク接続を確認
- 対象サイトのレスポンス速度を確認
- 並列度と深さパラメータを調整

## 📝 今後の改善案

### AIエージェント
- [x] 自然言語からCypherクエリ生成（実装済み）
- [x] 日本語対応（実装済み）
- [ ] クエリ結果の可視化機能
- [ ] 複数モデルの選択対応
- [ ] クエリ履歴の保存機能
- [ ] バッチ処理モード
- [ ] Webインターフェース

### 補助ツール
- [x] 認証が必要なサイトへの対応（実装済み）
- [x] JavaScriptで動的に生成される要素の取得（実装済み）
- [x] 並列クロール処理の実装（実装済み）
- [ ] クロール進捗のリアルタイム表示
- [ ] クロール結果のエクスポート機能
- [ ] APIレスポンスのキャプチャ
- [ ] 状態の差分検出機能

## 📄 ライセンス

このプロジェクトはMITライセンスの下で公開されています。

## 🤝 貢献

プルリクエストを歓迎します。大きな変更を行う場合は、まずissueを作成して変更内容について議論してください。

## 📞 サポート

問題が発生した場合は、GitHubのissueを作成してください。

## 注意

- 設定は `.env` に統一しています。Python の設定ファイルやスクリプトは使用していません。