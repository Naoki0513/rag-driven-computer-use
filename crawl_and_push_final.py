import asyncio, sys, json
from neo4j import GraphDatabase
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from crawl4ai.deep_crawling import BFSDeepCrawlStrategy

NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "testpassword"

async def crawl(domain: str, depth: int = 3):
    print(f"⚡ Starting deep crawl of {domain} with depth {depth}")
    cfg = CrawlerRunConfig(
        deep_crawl_strategy=BFSDeepCrawlStrategy(
            max_depth=depth, 
            include_external=False
        ),
        wait_for='body',  # Wait for page body to load
        verbose=True
    )
    
    async with AsyncWebCrawler(headless=True) as crawler:
        result = await crawler.arun(domain, config=cfg)
        return result

def push(crawl_result):
    print(f"\n📊 Processing crawl results...")
    drv = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    
    try:
        with drv.session() as s:
            # Neo4jのノードをクリア
            s.run("MATCH (n) DETACH DELETE n")
            print("🗑️ Cleared existing graph data")
            
            # Handle different result formats
            if isinstance(crawl_result, list):
                # It's already a list
                if len(crawl_result) > 0 and hasattr(crawl_result[0], '_results'):
                    results = crawl_result[0]._results
                else:
                    results = crawl_result
            elif hasattr(crawl_result, '_results'):
                results = crawl_result._results
            else:
                results = [crawl_result]
            
            node_count = 0
            edge_count = 0
            
            for result in results:
                url = result.url if hasattr(result, 'url') else result.get('url', '')
                if url:
                    print(f"📄 Processing: {url}")
                    title = 'No Title'
                    if hasattr(result, 'metadata') and result.metadata:
                        title = result.metadata.get('title', 'No Title') or 'No Title'
                    
                    s.run("MERGE (p:Page {url:$u, title:$t})", 
                          u=url, 
                          t=title)
                    node_count += 1
                    
                    # Process links
                    links = result.links if hasattr(result, 'links') else result.get('links', {})
                    internal_links = links.get("internal", [])
                    
                    if internal_links:
                        print(f"  → Found {len(internal_links)} internal links")
                        for link in internal_links:
                            target_url = link["href"] if isinstance(link, dict) else link
                            if target_url:
                                s.run("MERGE (q:Page {url:$u})", u=target_url)
                                s.run("""
                                    MATCH (p:Page {url:$src}), (q:Page {url:$dst})
                                    MERGE (p)-[:LINKS_TO]->(q)
                                """, src=url, dst=target_url)
                                edge_count += 1
                    else:
                        print(f"  → No internal links found")
                        
            print(f"\n✅ Graph created with {node_count} nodes and {edge_count} edges")
                            
    except Exception as e:
        print(f"❌ Error pushing to Neo4j: {e}")
    finally:
        drv.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python crawl_and_push_final.py <URL> [depth]")
        sys.exit(1)
        
    start = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    
    print(f"🌐 Web Graph Crawler")
    print(f"   Target: {start}")
    print(f"   Depth: {depth}")
    print("-" * 50)
    
    data = asyncio.run(crawl(start, depth))
    push(data)
    
    print("\n" + "="*50)
    print("📈 Crawl completed!")
    print(f"🔗 View graph at: http://localhost:7474")
    print(f"   Login: {NEO4J_USER} / {NEO4J_PASSWORD}")
    print("="*50) 