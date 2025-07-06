# Web Graph Crawler

Webページをクロールし、ページ間のリンク関係をNeo4jグラフデータベースに格納するツールです。

## 🎯 プロジェクト概要

このプロジェクトは、Webドメイン内のページ構造を分析し、ページ間の遷移関係をグラフデータベース（Neo4j）に格納することを目的としています。

## 📋 必要な環境

### 1. Neo4j
- URI: `bolt://localhost:7687`
- Web UI: `http://localhost:7474`
- 認証情報: neo4j / testpassword

### 2. Python 3.x
必要なパッケージ:
```bash
pip install neo4j crawl4ai beautifulsoup4 requests
```

## 🔧 プロジェクト構成

```
webgraph-demo/
├── README.md                       # このファイル
├── simple_crawl.py                # メインのWebクローラー
├── crawl_and_push_final.py        # 高度なクローリング機能
├── state_graph_crawler.py         # 状態遷移グラフ収集（Playwright版）
├── state_graph_crawler_crawl4ai.py # 状態遷移グラフ収集（軽量版）
├── query_neo4j.py                 # Neo4jクエリツール
├── test_neo4j_connection.py       # Neo4j接続テスト
├── neo4j_queries.md               # Neo4jクエリサンプル集
└── .gitignore                     # Git除外設定
```

## 🚀 使い方

### 1. Neo4j接続テスト
```bash
python test_neo4j_connection.py
```

### 2. 🆕 Webアプリケーション状態遷移グラフの収集

SPAを含むあらゆるWebアプリケーションの状態遷移を完全に記録する新機能です。

#### 特徴
- ✅ ページの完全な状態を保存（HTML、ARIA snapshot、スクリーンショット）
- ✅ インタラクティブな要素（ボタン、リンク）のクリックによる状態遷移を記録
- ✅ Neo4jに状態（State）ノードと遷移（TRANSITION）エッジとして保存
- ✅ ログイン認証にも対応

#### セットアップ
```bash
# 仮想環境の作成と有効化
python3 -m venv venv
source venv/bin/activate

# Playwright版の依存関係インストール
pip install playwright neo4j
playwright install chromium

# または軽量版の依存関係
pip install crawl4ai beautifulsoup4 neo4j
```

#### 実行方法
```bash
# Playwright版（推奨）- フル機能
python state_graph_crawler.py

# crawl4ai版（軽量）- スクリーンショットなし
python state_graph_crawler_crawl4ai.py
```

#### Neo4jでの確認
```cypher
# 状態と遷移を可視化
MATCH (s1:State)-[t:TRANSITION]->(s2:State) 
RETURN s1, t, s2

# ページ内容を確認
MATCH (s:State)-[:HAS_CONTENT]->(c:Content)
RETURN s.url, s.title, substring(c.html, 0, 200)
```

### 3. 従来のWebサイトクロール

#### `simple_crawl.py` (推奨)
シンプルなBFSアルゴリズムでWebサイトをクロールします。

```bash
python simple_crawl.py <URL> [深さ]
```

例:
```bash
python simple_crawl.py https://www.wikipedia.org 2
```

#### `crawl_and_push_final.py`
crawl4aiの高度な機能を使用した深層クロール：

```bash
python crawl_and_push_final.py <URL> [深さ]
```

### 3. Neo4jでデータを確認

#### `query_neo4j.py`
コマンドラインからNeo4jにクエリを実行：

```bash
# 統計情報を表示
python query_neo4j.py

# インタラクティブモード
python query_neo4j.py interactive
```

## 🔍 Neo4jでグラフを表示

1. ブラウザで http://localhost:7474 にアクセス
2. ログイン: neo4j / testpassword
3. 以下のクエリを実行:

```cypher
# すべてのページとリンクを表示
MATCH (p)-[r:LINKS_TO]->(q) 
RETURN p,r,q

# ページ数を確認
MATCH (p:Page) 
RETURN count(p) as pageCount

# リンク数を確認
MATCH ()-[r:LINKS_TO]->() 
RETURN count(r) as linkCount
```

## ⚠️ 注意事項

- 対象サイトの利用規約を確認してください
- クロール頻度に注意（サーバー負荷を考慮）
- SPAサイトや認証が必要なサイトでは内部リンクが取得できない場合があります

## 🛠️ トラブルシューティング

### Neo4j接続エラー
```bash
docker ps  # コンテナ状態確認
docker logs neo4j-crawler  # ログ確認
docker restart neo4j-crawler  # 再起動
```

### クロールでリンクが見つからない
- JavaScriptで動的生成されるサイトの可能性
- 認証が必要なサイトの可能性
- robots.txtで制限されている可能性

## 📝 今後の改善案

1. ~~JavaScript実行をサポート（Selenium/Puppeteer統合）~~ ✅ 実装済み（Playwright版）
2. ~~認証機能の追加~~ ✅ 実装済み
3. クロール結果の可視化改善
4. パフォーマンス最適化（並列クロール）
5. フォーム入力による状態遷移の記録
6. より高度なARIA情報の抽出と活用
7. 状態の差分検出による効率的な記録 