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

優先順位: CLI > .env > デフォルト。

## 🚀 使い方

### 1. TypeScript クローラー（本移行範囲）

```bash
npm run typecheck
npm run build
npm start -- --url http://the-agent-company.com:3000/ --headful
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

#### CLI オプション
```bash
node dist/main.js \
  --url <URL> \
  --user <USER> \
  --password <PASSWORD> \
  --depth 20 \
  --limit 10000 \
  --parallel 8 \
  --headful \
  --no-clear \
  --exhaustive
```

#### Neo4j接続診断
```bash
# データベース接続をテスト
python utilities/test_neo4j_connection.py
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

### 設定ファイル（agent/config.py）

```python
# Neo4j設定
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

# AWS Bedrock設定
AWS_REGION = "us-west-2"
BEDROCK_MODEL_ID = "us.anthropic.claude-3-7-sonnet-20250219-v1:0"
```

### クローラー設定（utilities/crawler.py）

```python
# デフォルト値
MAX_STATES = 10000                  # 最大状態数
MAX_DEPTH = 20                      # 最大探索深度
PARALLEL_TASKS = 8                  # 並列タスク数
MAX_HTML_SIZE = 100 * 1024          # 100KB
MAX_ARIA_CONTEXT_SIZE = 2 * 1024    # 2KB
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
- Node版では `node utilities/test_neo4j_connection.js`（将来提供予定）

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

## 移行ノート（Python → TypeScript）

- 設定は `.env` へ統一（CLIが最優先）
- Playwright の `Locator.ariaSnapshot()` はバージョン相違により未対応の可能性があるため、フォールバックとして `page.accessibility.snapshot()` のYAML化を採用
- Neo4j未接続時はスキップ実行可能（ログに警告を出力）
- 主要クラス/関数の対応: `WebCrawler`/`captureNode`/`interactions_from_snapshot`/`save_node` 等をTSへ移植

crawler.pyの実行が途中で止まる問題の原因と修正:

### 問題の原因
- ページ遷移後、要素が完全に利用可能になる前にクリックしようとするため、インタラクションが失敗する。
- ログイン処理でのタイムアウトや要素検出のタイミングの問題。

### 修正内容
1. **_find_interactionsメソッド**:
   - 要素の可視性(is_visible())と有効性(is_enabled())を確認して、利用可能な要素のみを対象とする。

2. **_process_interactionメソッド**:
   - wait_for_selectorを使って要素がvisibleになるまで待機(タイムアウト10秒)。
   - クリック前にis_enabled()を確認。

3. **_loginメソッド**:
   - gotoのwait_untilを'load'に設定し、タイムアウトを60秒に。
   - networkidleの待機をtry-exceptでハンドルし、タイムアウト時は継続。
   - 追加のwait_for_timeout(5000)を挿入。

4. **runメソッド**:
   - 初期状態キャプチャ前にwait_for_timeout(5000)を追加。
   - ページ移動後にwait_for_timeout(5000)を追加。

### 結果
- これらの修正により、ノード26個、エッジ162個のグラフを正常に生成。

詳細はutilities/crawler.pyを参照。