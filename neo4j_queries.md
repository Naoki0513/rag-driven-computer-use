# Neo4j クエリサンプル - 状態遷移グラフ

## 基本的なクエリ

### すべての状態を表示
```cypher
MATCH (s:State) 
RETURN s
```

### 状態と遷移を表示
```cypher
MATCH (s1:State)-[t:TRANSITION]->(s2:State) 
RETURN s1, t, s2 
LIMIT 50
```

### 特定のURLから始まる遷移を表示
```cypher
MATCH (s:State {url: 'http://the-agent-company.com:3000/home'})-[t:TRANSITION]->(s2:State)
RETURN s, t, s2
```

## コンテンツ関連のクエリ

### 状態とそのコンテンツを表示
```cypher
MATCH (s:State)-[:HAS_CONTENT]->(c:Content)
RETURN s.url, s.title, substring(c.html, 0, 100) as html_preview
LIMIT 10
```

### ARIA情報を含む状態を表示
```cypher
MATCH (s:State)-[:HAS_CONTENT]->(c:Content)
WHERE c.aria_snapshot IS NOT NULL
RETURN s.url, c.aria_snapshot
LIMIT 5
```

## 分析クエリ

### 最も多くリンクされているページ
```cypher
MATCH (s:State)<-[:TRANSITION]-(from:State)
RETURN s.url, count(from) as incoming_links
ORDER BY incoming_links DESC
LIMIT 10
```

### 遷移タイプ別の統計
```cypher
MATCH ()-[t:TRANSITION]->()
RETURN t.action_type, count(*) as count
ORDER BY count DESC
```

### ページごとの出力リンク数
```cypher
MATCH (s:State)-[t:TRANSITION]->(to:State)
RETURN s.url, count(t) as outgoing_links
ORDER BY outgoing_links DESC
```

### 孤立したページ（リンクがない）
```cypher
MATCH (s:State)
WHERE NOT (s)-[:TRANSITION]-() AND NOT ()-[:TRANSITION]-(s)
RETURN s.url
```

## グラフ構造の分析

### パスの探索（2つのページ間）
```cypher
MATCH path = shortestPath((start:State {url: 'http://the-agent-company.com:3000/home'})-[:TRANSITION*]-(end:State {url: 'http://the-agent-company.com:3000/privacy-policy'}))
RETURN path
```

### 循環参照の検出
```cypher
MATCH (s:State)-[:TRANSITION*2..5]->(s)
RETURN DISTINCT s.url
```

## データクリーニング

### すべてのデータを削除
```cypher
MATCH (n) DETACH DELETE n
```