# Webgraph Demo - Neo4j状態遷移グラフクローラー

Webアプリケーションの状態遷移をクロールし、Neo4jグラフデータベースに格納するツールです。

## 🎯 プロジェクト概要

このプロジェクトは、Webアプリケーション（特にRocket.Chat）の状態遷移を完全に記録し、ページ間の遷移関係をグラフデータベース（Neo4j）に格納することを目的としています。

## 📋 必要な環境

### 1. Neo4j
- URI: `bolt://localhost:7687`
- Web UI: `http://localhost:7474`
- 認証情報: neo4j / testpassword

### 2. Python 3.x
必要なパッケージ:
```bash
pip install neo4j playwright crawl4ai beautifulsoup4 requests
playwright install chromium
```

## 🔧 プロジェクト構成

```
webgraph-demo/
├── README.md                            # このファイル
├── complete_rocket_chat_crawler.py      # 完全版Rocket.Chatクローラー
├── full_state_graph_crawler.py          # 包括的状態遷移クローラー
├── simple_crawl.py                      # シンプルWebクローラー
├── query_neo4j.py                       # Neo4jクエリツール
├── test_neo4j_connection.py             # Neo4j接続テスト
├── neo4j_queries.md                     # Neo4jクエリサンプル集
└── .gitignore                           # Git除外設定
```

## 🚀 使い方

### 1. Neo4j接続テスト
```bash
python test_neo4j_connection.py
```

### 2. Rocket.Chat完全クロール（推奨）
最も包括的なRocket.Chatアプリケーション状態遷移の記録：

```bash
python complete_rocket_chat_crawler.py
```

#### 特徴
- ✅ ログイン認証対応
- ✅ 完全な状態記録（HTML、ARIA snapshot、スクリーンショット）
- ✅ インタラクティブ要素の自動検出・操作
- ✅ 状態遷移の完全記録
- ✅ Neo4jへのグラフ保存

### 3. 包括的状態遷移クロール
あらゆるWebアプリケーションに対応する汎用的な状態遷移クローラー：

```bash
python full_state_graph_crawler.py
```

### 4. シンプルWebクロール
従来のWebサイトクロール：

```bash
python simple_crawl.py <URL> [深さ]
```

例:
```bash
python simple_crawl.py https://www.wikipedia.org 2
```

### 5. Neo4jデータ確認

#### コマンドライン
```bash
# 統計情報を表示
python query_neo4j.py

# インタラクティブモード
python query_neo4j.py interactive
```

#### Webブラウザ
1. http://localhost:7474 にアクセス
2. ログイン: neo4j / testpassword
3. 以下のクエリを実行:

```cypher
# すべての状態と遷移を表示
MATCH (s1:State)-[t:TRANSITION]->(s2:State) 
RETURN s1, t, s2 LIMIT 50

# 状態タイプ別の統計
MATCH (s:State) 
RETURN s.state_type, count(*) as count 
ORDER BY count DESC
```

## 📊 出力データ構造

### 状態ノード (State)
- `hash`: 状態の一意識別子
- `url`: ページURL
- `title`: ページタイトル
- `state_type`: 状態タイプ（channel, dm, home, settings等）
- `timestamp`: 記録日時

### 遷移エッジ (TRANSITION)
- `action_type`: アクション種類（click, navigate, submit）
- `element_selector`: 操作した要素のセレクタ
- `element_text`: 操作した要素のテキスト

### コンテンツノード (Content)
- `html`: ページのHTML
- `aria_snapshot`: ARIA情報のJSON
- `screenshot`: スクリーンショット（Base64）

## ⚠️ 注意事項

- 対象サイトの利用規約を確認してください
- クロール頻度に注意（サーバー負荷を考慮）
- ログイン認証が必要なサイトでは認証情報を適切に設定してください

## 🛠️ トラブルシューティング

### Neo4j接続エラー
```bash
python test_neo4j_connection.py  # 接続テスト実行
```

### クロール結果が少ない場合
- JavaScript必須のSPAサイトの可能性
- 認証設定の確認
- ネットワーク接続の確認

## 📝 設定変更

各クローラーファイルの冒頭で以下の設定を変更可能：

```python
# Neo4j設定
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

# 対象サイト設定
TARGET_URL = "http://your-target-site.com"
LOGIN_USERNAME = "your-username"
LOGIN_PASSWORD = "your-password"
```

## 📈 今後の改善案

1. リアルタイム状態監視機能
2. 状態差分検出の最適化
3. 並列クロール処理
4. より高度な要素認識アルゴリズム
5. 可視化ダッシュボードの追加 