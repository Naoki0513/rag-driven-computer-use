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
        
        # デバッグ情報を出力
        print(f"\nResult type: {type(result)}")
        
        if isinstance(result, list):
            print(f"List length: {len(result)}")
            if len(result) > 0:
                print(f"First item type: {type(result[0])}")
                if hasattr(result[0], '__dict__'):
                    print(f"First item attributes: {result[0].__dict__.keys()}")
                    # links属性をチェック
                    if hasattr(result[0], 'links'):
                        print(f"Links type: {type(result[0].links)}")
                        print(f"Links sample: {result[0].links}")
        
        return result

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python crawl_and_push_debug.py <URL> [depth]")
        sys.exit(1)
        
    start = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    
    print(f"Starting crawl of {start} with depth {depth}...")
    data = asyncio.run(crawl(start, depth))
    print(f"\nFinal result: {data}") 