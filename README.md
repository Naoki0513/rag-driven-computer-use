# Web Graph Crawler

Webページをクロールし、ページ間のリンク関係をNeo4jグラフデータベースに格納するツールです。

## 🚀 セットアップ完了内容

### 1. Docker環境
- Neo4jコンテナ: `neo4j-crawler`
- ポート: 7474 (Web UI), 7687 (Bolt)
- 認証情報: neo4j / testpassword

### 2. Python環境
- 仮想環境: `.venv`
- 主要パッケージ:
  - crawl4ai: Webクローリング
  - neo4j: グラフデータベース接続
  - scrapegraphai: スクレイピング支援

### 3. 作成したスクリプト

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
crawl4aiの深層クロール機能を使用（実験的）

## 📊 実行結果

### テスト結果
- `http://the-agent-company.com:3000`: 内部リンクなし（SPA/認証サイトの可能性）
- `https://www.wikipedia.org`: 340リンクを検出（成功）

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