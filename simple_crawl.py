import asyncio, sys
from neo4j import GraphDatabase
from crawl4ai import AsyncWebCrawler
from urllib.parse import urlparse, urljoin

NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "testpassword"

async def crawl_site(start_url: str, max_depth: int = 3):
    """Simple BFS crawling"""
    visited = set()
    to_visit = [(start_url, 0)]
    results = []
    
    async with AsyncWebCrawler(headless=True) as crawler:
        while to_visit:
            url, depth = to_visit.pop(0)
            
            if url in visited or depth > max_depth:
                continue
                
            print(f"🔍 Crawling: {url} (depth: {depth})")
            visited.add(url)
            
            try:
                result = await crawler.arun(url)
                if result.success:
                    results.append({
                        'url': url,
                        'title': result.metadata.get('title', 'No Title') if result.metadata else 'No Title',
                        'links': result.links,
                        'depth': depth
                    })
                    
                    # Add internal links to queue
                    for link in result.links.get('internal', []):
                        href = link['href'] if isinstance(link, dict) else link
                        if href and href not in visited:
                            full_url = urljoin(url, href)
                            if urlparse(full_url).netloc == urlparse(start_url).netloc:
                                to_visit.append((full_url, depth + 1))
                                
            except Exception as e:
                print(f"❌ Error crawling {url}: {e}")
                
    return results

def push_to_neo4j(results):
    """Push crawl results to Neo4j"""
    print(f"\n📊 Pushing {len(results)} pages to Neo4j...")
    drv = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    
    try:
        with drv.session() as s:
            # Clear existing data
            s.run("MATCH (n) DETACH DELETE n")
            print("🗑️ Cleared existing graph")
            
            # Create nodes and edges
            edge_count = 0
            for page in results:
                # Create page node
                s.run("""
                    MERGE (p:Page {url: $url})
                    SET p.title = $title, p.depth = $depth
                """, url=page['url'], title=page['title'], depth=page['depth'])
                
                # Create edges
                for link in page['links'].get('internal', []):
                    target = link['href'] if isinstance(link, dict) else link
                    if target:
                        full_target = urljoin(page['url'], target)
                        s.run("""
                            MATCH (p:Page {url: $src})
                            MERGE (q:Page {url: $dst})
                            MERGE (p)-[:LINKS_TO]->(q)
                        """, src=page['url'], dst=full_target)
                        edge_count += 1
                        
            print(f"✅ Created {len(results)} nodes and {edge_count} edges")
            
    except Exception as e:
        print(f"❌ Neo4j error: {e}")
    finally:
        drv.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python simple_crawl.py <URL> [max_depth]")
        sys.exit(1)
        
    url = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    
    print(f"🌐 Simple Web Crawler")
    print(f"   Target: {url}")
    print(f"   Max Depth: {depth}")
    print("-" * 50)
    
    results = asyncio.run(crawl_site(url, depth))
    
    if results:
        push_to_neo4j(results)
    else:
        print("❌ No pages crawled")
        
    print("\n" + "="*50)
    print("📈 View graph at: http://localhost:7474")
    print(f"   Login: {NEO4J_USER} / {NEO4J_PASSWORD}")
    print("   Query: MATCH (p)-[r:LINKS_TO]->(q) RETURN p,r,q")
    print("="*50) 