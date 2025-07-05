import asyncio, sys, json
from neo4j import GraphDatabase
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from crawl4ai.deep_crawling import BFSDeepCrawlStrategy

NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "testpassword"

async def crawl(domain: str, depth: int = 3):
    cfg = CrawlerRunConfig(
        deep_crawl_strategy=BFSDeepCrawlStrategy(max_depth=depth, include_external=False)
    )
    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(domain, config=cfg)
        # Deep crawling結果を取得
        if hasattr(result, 'crawled_results'):
            return result.crawled_results
        else:
            return [result]

def push(results):
    print(f"Processing {len(results)} pages...")
    drv = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with drv.session() as s:
            # Neo4jのノードをクリア
            s.run("MATCH (n) DETACH DELETE n")
            
            for r in results:
                url = r.url if hasattr(r, 'url') else r.get('url', '')
                if url:
                    print(f"Processing page: {url}")
                    s.run("MERGE (p:Page {url:$u})", u=url)
                    
                    # 内部リンクを処理
                    links = r.links if hasattr(r, 'links') else r.get('links', {})
                    internal_links = links.get("internal", [])
                    
                    for link in internal_links:
                        tgt = link["href"] if isinstance(link, dict) else link
                        if tgt:
                            s.run("MERGE (q:Page {url:$u})", u=tgt)
                            s.run("""
                                MATCH (p:Page {url:$src}),(q:Page {url:$dst})
                                MERGE (p)-[:LINKS_TO]->(q)
                            """, src=url, dst=tgt)
                            
    except Exception as e:
        print(f"Error pushing to Neo4j: {e}")
    finally:
        drv.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python crawl_and_push.py <URL> [depth]")
        sys.exit(1)
        
    start = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    
    print(f"Starting crawl of {start} with depth {depth}...")
    data = asyncio.run(crawl(start, depth))
    
    push(data)
    print(json.dumps({"crawled_pages": len(data), "status": "completed"}, indent=2, ensure_ascii=False))
