# WebGraph-Agent

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

### Python
- Python 3.9以上（3.12.3推奨）
- pip 24.0以上

### AWS Bedrock（AIエージェント用）
- AWS アカウント
- Bedrock API アクセス権限
- Claude 3 Sonnet モデルへのアクセス権限

## 🔧 セットアップ

### 1. リポジトリのクローン
```bash
git clone https://github.com/yourusername/WebGraph-Agent.git
cd WebGraph-Agent
```

### 2. 仮想環境の作成（推奨）
```bash
# 仮想環境の作成
python -m venv venv

# 仮想環境の有効化（Windows）
venv\Scripts\activate

# 仮想環境の有効化（Linux/Mac）
source venv/bin/activate
```

### 3. 依存関係のインストール
```bash
pip install -r requirements.txt
python -m playwright install
```

### 4. システム依存関係のインストール（Linux/WSL）
```bash
sudo playwright install-deps
```

### 5. 環境変数の設定
```bash
# .env.exampleをコピー
cp .env.example .env

# .envファイルを編集してNeo4jとAWSの認証情報を設定
# エディタで .env を開いて以下を設定：
# - NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
# - AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

## 🚀 使い方

### 1. AIエージェント（メイン機能）

Neo4jデータベースに対して自然言語でクエリを実行できます：

```bash
# AIエージェントを起動
python agent/bedrock_agent.py
```

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

#### Webクローラー（データ収集）
```bash
# 基本的な使用
python utilities/crawler.py --url https://example.com

# 詳細なオプション
python utilities/crawler.py --url https://example.com --depth 5 --limit 100 --parallel 16

# 認証が必要なサイト
python utilities/crawler.py --url https://app.example.com --user myuser --password mypass
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

### 環境変数（.envファイル）

```env
# Neo4j接続情報
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=testpassword

# AWS Bedrock設定
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
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
- AWS認証情報が正しく設定されているか確認
- AWS CLIがインストールされている場合は `aws configure` で設定確認
- Bedrockへのアクセス権限があるか確認

#### Bedrock APIエラー
- リージョンが正しいか確認（Claude 3 Sonnetが利用可能なリージョン）
- モデルIDが正しいか確認
- APIクォータを超えていないか確認

### Neo4j接続エラー
- Neo4jが起動していることを確認
- 接続情報（URI、ユーザー名、パスワード）を確認
- `python utilities/test_neo4j_connection.py` で診断実行

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