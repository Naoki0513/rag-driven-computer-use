import asyncio, sys, json
from neo4j import GraphDatabase
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from crawl4ai.deep_crawling import BFSDeepCrawlStrategy

NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "testpassword"

# Target site configuration
TARGET_URL = "http://the-agent-company.com:3000"
LOGIN_USERNAME = "theagentcompany"
LOGIN_PASSWORD = "theagentcompany"

async def login_and_crawl(domain: str, depth: int = 3):
    """Login to the agent company site and crawl all pages"""
    print(f"⚡ Starting login and deep crawl of {domain} with depth {depth}")
    
    # First, we need to identify the login form
    async with AsyncWebCrawler(headless=True) as crawler:
        # Get the login page
        print(f"🔍 Accessing login page: {domain}")
        login_result = await crawler.arun(domain)
        
        if not login_result.success:
            print(f"❌ Failed to access login page: {login_result.error_message}")
            return []
        
        print(f"✅ Successfully accessed login page")
        
        # Configure crawler with authentication
        cfg = CrawlerRunConfig(
            deep_crawl_strategy=BFSDeepCrawlStrategy(
                max_depth=depth, 
                include_external=False
            ),
            wait_for='body',
            verbose=True
        )
        
        # Try to perform login using JavaScript injection
        js_code = f"""
        // Try to find and fill login form
        const usernameFields = document.querySelectorAll('input[type="text"], input[type="email"], input[name*="user"], input[name*="username"], input[name*="login"], input[id*="user"], input[id*="username"], input[id*="login"]');
        const passwordFields = document.querySelectorAll('input[type="password"], input[name*="pass"], input[id*="pass"]');
        const submitButtons = document.querySelectorAll('button[type="submit"], input[type="submit"], button:contains("Login"), button:contains("Sign in")');
        
        console.log('Found username fields:', usernameFields.length);
        console.log('Found password fields:', passwordFields.length);
        console.log('Found submit buttons:', submitButtons.length);
        
        if (usernameFields.length > 0) {{
            usernameFields[0].value = '{LOGIN_USERNAME}';
            usernameFields[0].dispatchEvent(new Event('input', {{ bubbles: true }}));
            usernameFields[0].dispatchEvent(new Event('change', {{ bubbles: true }}));
            console.log('Username field filled');
        }}
        
        if (passwordFields.length > 0) {{
            passwordFields[0].value = '{LOGIN_PASSWORD}';
            passwordFields[0].dispatchEvent(new Event('input', {{ bubbles: true }}));
            passwordFields[0].dispatchEvent(new Event('change', {{ bubbles: true }}));
            console.log('Password field filled');
        }}
        
        // Wait a bit for any JavaScript validation
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (submitButtons.length > 0) {{
            submitButtons[0].click();
            console.log('Submit button clicked');
        }}
        
        // Wait for redirect or page change
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        return {{
            success: true,
            url: window.location.href,
            title: document.title
        }};
        """
        
        # First attempt: try to login
        print(f"🔐 Attempting to login...")
        login_attempt = await crawler.arun(
            domain,
            config=CrawlerRunConfig(
                js_code=js_code,
                wait_for='body',
                page_timeout=30000,
                verbose=True
            )
        )
        
        if login_attempt.success:
            print(f"✅ Login attempt completed")
            print(f"📄 Current URL: {login_attempt.url}")
            
            # Now perform the deep crawl starting from the current authenticated state
            print(f"🚀 Starting deep crawl from authenticated session...")
            
            crawl_result = await crawler.arun(
                login_attempt.url,  # Start from wherever we landed after login
                config=cfg
            )
            
            return crawl_result
        else:
            print(f"❌ Login failed: {login_attempt.error_message}")
            return []

async def crawl_with_basic_auth(domain: str, depth: int = 3):
    """Alternative approach using basic authentication if available"""
    print(f"⚡ Starting crawl with basic auth attempt of {domain} with depth {depth}")
    
    cfg = CrawlerRunConfig(
        deep_crawl_strategy=BFSDeepCrawlStrategy(
            max_depth=depth, 
            include_external=False
        ),
        wait_for='body',
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
                    
                    # Store additional metadata about the agent company site
                    content_length = len(result.markdown) if hasattr(result, 'markdown') and result.markdown else 0
                    
                    s.run("""
                        MERGE (p:Page {url:$u})
                        SET p.title = $t, p.content_length = $cl, p.domain = $d
                    """, 
                          u=url, 
                          t=title,
                          cl=content_length,
                          d="the-agent-company.com")
                    node_count += 1
                    
                    # Process links
                    links = result.links if hasattr(result, 'links') else result.get('links', {})
                    internal_links = links.get("internal", [])
                    
                    if internal_links:
                        print(f"  → Found {len(internal_links)} internal links")
                        for link in internal_links:
                            target_url = link["href"] if isinstance(link, dict) else link
                            if target_url:
                                # Ensure we only store agent company links
                                if "the-agent-company.com" in target_url or target_url.startswith("/"):
                                    s.run("MERGE (q:Page {url:$u, domain:$d})", 
                                          u=target_url, d="the-agent-company.com")
                                    s.run("""
                                        MATCH (p:Page {url:$src}), (q:Page {url:$dst})
                                        MERGE (p)-[:LINKS_TO]->(q)
                                    """, src=url, dst=target_url)
                                    edge_count += 1
                    else:
                        print(f"  → No internal links found")
                        
            print(f"\n✅ Graph created with {node_count} nodes and {edge_count} edges")
            print(f"🌐 All pages from the-agent-company.com domain")
                            
    except Exception as e:
        print(f"❌ Error pushing to Neo4j: {e}")
    finally:
        drv.close()

if __name__ == "__main__":
    start = TARGET_URL
    depth = 5  # Increased depth to crawl more of the site
    
    print(f"🌐 Agent Company Web Graph Crawler")
    print(f"   Target: {start}")
    print(f"   Depth: {depth}")
    print(f"   Username: {LOGIN_USERNAME}")
    print(f"   Password: {'*' * len(LOGIN_PASSWORD)}")
    print("-" * 50)
    
    # First try login-based crawling
    print("🔐 Attempting login-based crawling...")
    data = asyncio.run(login_and_crawl(start, depth))
    
    # If that fails, try basic auth
    if not data or (isinstance(data, list) and len(data) == 0):
        print("🔄 Trying basic authentication approach...")
        data = asyncio.run(crawl_with_basic_auth(start, depth))
    
    # If still no results, try simple crawl without auth
    if not data or (isinstance(data, list) and len(data) == 0):
        print("🔄 Trying simple crawl without authentication...")
        cfg = CrawlerRunConfig(
            deep_crawl_strategy=BFSDeepCrawlStrategy(
                max_depth=depth, 
                include_external=False
            ),
            wait_for='body',
            verbose=True
        )
        
        async def simple_crawl():
            async with AsyncWebCrawler(headless=True) as crawler:
                result = await crawler.arun(start, config=cfg)
                return result
        
        data = asyncio.run(simple_crawl())
    
    if data:
        push(data)
    else:
        print("❌ No data crawled from the agent company site")
    
    print("\n" + "="*50)
    print("📈 Crawl completed!")
    print(f"🔗 View graph at: http://localhost:7474")
    print(f"   Login: {NEO4J_USER} / {NEO4J_PASSWORD}")
    print(f"🎯 Query to view all agent company pages:")
    print(f"   MATCH (p:Page {{domain: 'the-agent-company.com'}}) RETURN p")
    print(f"🔗 Query to view page relationships:")
    print(f"   MATCH (p)-[r:LINKS_TO]->(q) WHERE p.domain = 'the-agent-company.com' RETURN p,r,q")
    print("="*50) 