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
├── README.md                    # このファイル
├── simple_crawl.py             # メインのWebクローラー
├── crawl_and_push_final.py     # 高度なクローリング機能
├── query_neo4j.py              # Neo4jクエリツール
├── test_neo4j_connection.py    # Neo4j接続テスト
└── .gitignore                  # Git除外設定
```

## 🚀 使い方

### 1. Neo4j接続テスト
```bash
python test_neo4j_connection.py
```

### 2. Webサイトのクロール

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

1. JavaScript実行をサポート（Selenium/Puppeteer統合）
2. 認証機能の追加
3. クロール結果の可視化改善
4. パフォーマンス最適化（並列クロール） 