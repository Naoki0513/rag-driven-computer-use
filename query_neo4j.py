#!/usr/bin/env python3
"""
Neo4j直接クエリツール
ブラウザが使えない場合の代替手段
"""

from neo4j import GraphDatabase
import sys

NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

def execute_query(query, params=None):
    """Neo4jクエリを実行"""
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    
    try:
        with driver.session() as session:
            result = session.run(query, params or {})
            return list(result)
    except Exception as e:
        print(f"❌ Query error: {e}")
        return []
    finally:
        driver.close()

def show_sample_queries():
    """サンプルクエリを表示・実行"""
    print("🔍 Neo4j Direct Query Tool")
    print("="*50)
    
    # データベース統計
    print("\n📊 Database Statistics:")
    node_count = execute_query("MATCH (n) RETURN count(n) as count")
    if node_count:
        print(f"Total nodes: {node_count[0]['count']}")
    
    edge_count = execute_query("MATCH ()-[r]->() RETURN count(r) as count")
    if edge_count:
        print(f"Total relationships: {edge_count[0]['count']}")
    
    # ページラベルの確認
    print("\n📄 Node Labels:")
    labels = execute_query("CALL db.labels()")
    for label in labels:
        print(f"- {label['label']}")
    
    # サンプルノードを表示
    print("\n🌐 Sample Pages (first 10):")
    pages = execute_query("MATCH (p:Page) RETURN p.url, p.title LIMIT 10")
    for i, page in enumerate(pages, 1):
        title = page.get('p.title', 'No Title')
        url = page.get('p.url', 'No URL')
        print(f"{i:2d}. {title}")
        print(f"    URL: {url}")
    
    # リンク関係を表示
    print("\n🔗 Sample Links (first 5):")
    links = execute_query("""
        MATCH (p:Page)-[:LINKS_TO]->(q:Page) 
        RETURN p.url as source, q.url as target 
        LIMIT 5
    """)
    for i, link in enumerate(links, 1):
        print(f"{i}. {link['source']} → {link['target']}")

def interactive_mode():
    """インタラクティブクエリモード"""
    print("\n🎯 Interactive Query Mode")
    print("Enter Cypher queries (type 'exit' to quit):")
    print("Examples:")
    print("  MATCH (n) RETURN count(n)")
    print("  MATCH (p:Page) RETURN p.url LIMIT 5")
    print("-" * 50)
    
    while True:
        try:
            query = input("\nCypher> ").strip()
            if query.lower() in ['exit', 'quit', 'q']:
                break
            if not query:
                continue
                
            results = execute_query(query)
            if results:
                print(f"\n📋 Results ({len(results)} rows):")
                for i, record in enumerate(results[:20], 1):  # 最初の20件のみ表示
                    print(f"{i:2d}. {dict(record)}")
                if len(results) > 20:
                    print(f"... and {len(results) - 20} more rows")
            else:
                print("No results or query error.")
                
        except KeyboardInterrupt:
            print("\n\nExiting...")
            break
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "interactive":
            interactive_mode()
        else:
            show_sample_queries()
            
        print("\n" + "="*50)
        print("💡 Tips:")
        print("- Run with 'interactive' argument for query mode")
        print("- Try: python query_neo4j.py interactive")
        print("- Common queries:")
        print("  MATCH (p)-[r:LINKS_TO]->(q) RETURN p,r,q LIMIT 10")
        print("  MATCH (p:Page) WHERE p.url CONTAINS 'wiki' RETURN p")
        
    except Exception as e:
        print(f"Connection error: {e}")
        print("Make sure Neo4j is running on localhost:7687") 