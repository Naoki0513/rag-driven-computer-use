# Web Graph Crawler

Webアプリケーションの状態遷移をクロールし、ページ状態とユーザーインタラクションをNeo4jグラフデータベースに格納する高速並列クローラーです。

## 🎯 プロジェクト概要

このプロジェクトは、Webアプリケーションのページ状態とそれらの間の遷移を自動的に探索し、その構造をNeo4jグラフデータベースに保存します。単純なリンクだけでなく、ボタンクリックやフォーム送信などのインタラクションも記録し、アプリケーションの完全な状態遷移グラフを構築します。

## 📋 必要な環境

### Neo4j
- URI: `bolt://localhost:7687`
- Web UI: `http://localhost:7474`
- ユーザー名: `neo4j`
- パスワード: `testpassword`

### Python
- Python 3.12.3以上
- pip 24.0以上

## 🔧 セットアップ

### 1. リポジトリのクローン
```bash
git clone https://github.com/yourusername/webgraph-demo.git
cd webgraph-demo
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

## 🚀 使い方

### 基本的なクロール
```bash
python crawler.py --url <URL>
```

例：
```bash
# 基本的な使用
python crawler.py --url https://example.com

# 深さと状態数を指定
python crawler.py --url https://example.com --depth 5 --limit 100

# 認証が必要なサイト
python crawler.py --url https://app.example.com --user myuser --password mypass

# ブラウザを表示して実行（デバッグ用）
python crawler.py --url https://example.com --headful

# 並列度を上げて高速化
python crawler.py --url https://example.com --parallel 16

# すべての状態を探索（制限なし）
python crawler.py --url https://example.com --exhaustive
```

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

crawler.pyの冒頭で以下の設定を変更可能：

```python
# Neo4j接続情報
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

# クロール設定
TARGET_URL = "https://example.com"  # デフォルトURL
LOGIN_USER = "your_id"              # デフォルトユーザー名
LOGIN_PASS = "your_pass"            # デフォルトパスワード
MAX_STATES = 10000                  # 最大状態数
MAX_DEPTH = 20                      # 最大探索深度
PARALLEL_TASKS = 8                  # 並列タスク数

# HTML保存サイズ上限
MAX_HTML_SIZE = 100 * 1024          # 100KB
MAX_ARIA_CONTEXT_SIZE = 2 * 1024    # 2KB
```

## ⚠️ 注意事項

- 対象サイトの利用規約を確認してください
- 大規模なサイトをクロールする場合は、サーバーへの負荷に注意してください
- robots.txtの規約を尊重してください
- 必要に応じてクロール間隔を調整してください

## 🛠️ トラブルシューティング

### Neo4j接続エラー
- Neo4jが起動していることを確認
- 接続情報（URI、ユーザー名、パスワード）を確認
- ファイアウォールの設定を確認

### クロールが遅い場合
- ネットワーク接続を確認
- 対象サイトのレスポンス速度を確認
- 深さパラメータを調整

### メモリ不足
- 深さパラメータを小さくする
- 一度にクロールするページ数を制限する

## 📝 今後の改善案

- [x] 認証が必要なサイトへの対応（実装済み）
- [x] JavaScriptで動的に生成される要素の取得（実装済み）
- [x] 並列クロール処理の実装（実装済み）
- [ ] クロール結果の可視化機能
- [ ] クロール進捗のリアルタイム表示
- [ ] クロール結果のエクスポート機能
- [ ] フォーム入力の自動化
- [ ] スクリーンショットの保存
- [ ] APIレスポンスのキャプチャ
- [ ] 状態の差分検出機能