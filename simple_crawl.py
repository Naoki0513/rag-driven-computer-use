#!/usr/bin/env python3
"""
Simple Web Crawler for Neo4j
Crawls websites and stores page relationships in Neo4j graph database
"""

import asyncio
import sys
from neo4j import GraphDatabase
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from urllib.parse import urlparse, urljoin

# Neo4j configuration
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"


async def crawl_site(start_url: str, max_depth: int = 2):
    """
    Crawl a website using BFS algorithm
    
    Args:
        start_url: The starting URL to crawl
        max_depth: Maximum depth to crawl (default: 2)
    
    Returns:
        List of crawled pages with their links
    """
    print(f"🚀 Starting crawl of {start_url}")
    print(f"   Max depth: {max_depth}")
    
    visited = set()
    to_visit = [(start_url, 0)]
    results = []
    
    # Parse domain for filtering
    domain = urlparse(start_url).netloc
    
    async with AsyncWebCrawler(headless=True) as crawler:
        while to_visit:
            url, depth = to_visit.pop(0)
            
            if url in visited or depth > max_depth:
                continue
                
            print(f"🔍 Crawling: {url} (depth: {depth})")
            visited.add(url)
            
            try:
                result = await crawler.arun(
                    url,
                    config=CrawlerRunConfig(
                        wait_for='domcontentloaded',
                        page_timeout=30000,
                        verbose=False
                    )
                )
                
                if result.success:
                    # Get page metadata
                    title = result.metadata.get('title', 'No Title') if result.metadata else 'No Title'
                    
                    # Extract links
                    links = result.links or {'internal': [], 'external': []}
                    internal_links = []
                    
                    for link in links.get('internal', []):
                        href = link['href'] if isinstance(link, dict) else link
                        if href and href not in visited:
                            full_url = urljoin(url, href)
                            # Only process links from the same domain
                            if urlparse(full_url).netloc == domain:
                                internal_links.append(full_url)
                                to_visit.append((full_url, depth + 1))
                    
                    results.append({
                        'url': url,
                        'title': title,
                        'links': internal_links,
                        'depth': depth,
                        'domain': domain
                    })
                    
                    print(f"✅ Found {len(internal_links)} internal links")
                    
                else:
                    print(f"❌ Failed to crawl: {result.error_message if hasattr(result, 'error_message') else 'Unknown error'}")
                    
            except Exception as e:
                print(f"❌ Error crawling {url}: {e}")
                
    return results


def push_to_neo4j(results):
    """
    Push crawl results to Neo4j database
    
    Args:
        results: List of crawled pages with their links
    """
    if not results:
        print("❌ No results to push to Neo4j")
        return
        
    print(f"\n📊 Pushing {len(results)} pages to Neo4j...")
    
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    
    try:
        with driver.session() as session:
            # Clear existing data
            session.run("MATCH (n) DETACH DELETE n")
            print("🗑️  Cleared existing graph")
            
            # Create nodes for all pages
            for page in results:
                session.run("""
                    MERGE (p:Page {url: $url})
                    SET p.title = $title, 
                        p.depth = $depth,
                        p.domain = $domain
                """, 
                url=page['url'], 
                title=page['title'], 
                depth=page['depth'],
                domain=page['domain'])
            
            # Create edges (relationships)
            edge_count = 0
            for page in results:
                for link in page['links']:
                    session.run("""
                        MATCH (p:Page {url: $src})
                        MERGE (q:Page {url: $dst})
                        MERGE (p)-[:LINKS_TO]->(q)
                    """, src=page['url'], dst=link)
                    edge_count += 1
                    
            print(f"✅ Created {len(results)} nodes and {edge_count} edges")
            
            # Get statistics
            result = session.run("MATCH (n:Page) RETURN count(n) as count")
            node_count = result.single()['count']
            
            result = session.run("MATCH ()-[r:LINKS_TO]->() RETURN count(r) as count")
            edge_count = result.single()['count']
            
            print(f"\n📊 Graph statistics:")
            print(f"   Total pages: {node_count}")
            print(f"   Total links: {edge_count}")
            
    except Exception as e:
        print(f"❌ Neo4j error: {e}")
        print("Make sure Neo4j is running and accessible")
    finally:
        driver.close()


def main():
    """Main function"""
    if len(sys.argv) < 2:
        print("Usage: python simple_crawl.py <URL> [depth]")
        print("Example: python simple_crawl.py https://www.wikipedia.org 2")
        sys.exit(1)
    
    url = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    
    # Validate URL
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        print(f"❌ Invalid URL: {url}")
        print("Please provide a valid URL starting with http:// or https://")
        sys.exit(1)
    
    print(f"🌐 Web Graph Crawler")
    print(f"   Target: {url}")
    print(f"   Max Depth: {depth}")
    print("-" * 50)
    
    # Crawl the site
    results = asyncio.run(crawl_site(url, depth))
    
    if results:
        print(f"\n📈 Successfully crawled {len(results)} pages")
        
        # Push to Neo4j
        push_to_neo4j(results)
        
        print("\n" + "="*50)
        print("📈 View graph at: http://localhost:7474")
        print(f"   Login: {NEO4J_USER} / {NEO4J_PASSWORD}")
        print("\n🎯 Useful Cypher queries:")
        print("   - All pages: MATCH (n:Page) RETURN n")
        print("   - Page relationships: MATCH (p:Page)-[r:LINKS_TO]->(q:Page) RETURN p,r,q")
        print("   - Pages by depth: MATCH (p:Page) WHERE p.depth = 0 RETURN p")
        print("="*50)
    else:
        print("❌ No pages crawled")
        print("\nPossible reasons:")
        print("- The site blocks crawlers")
        print("- The site requires JavaScript (SPA)")
        print("- Network connectivity issues")
        print("- The site requires authentication")


if __name__ == "__main__":
    main()