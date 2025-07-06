import asyncio
import sys
import json
import base64
from datetime import datetime
from urllib.parse import urlparse, urljoin
from typing import Dict, List, Set, Optional, Tuple
from dataclasses import dataclass, field
import hashlib
import logging

from neo4j import GraphDatabase
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from bs4 import BeautifulSoup

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Neo4j configuration
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

# Target site configuration (from existing setup)
TARGET_URL = "http://the-agent-company.com:3000"
LOGIN_USERNAME = "theagentcompany"
LOGIN_PASSWORD = "theagentcompany"

@dataclass
class PageState:
    """Represents a state of a web page"""
    url: str
    html: str
    aria_info: str  # Simplified ARIA information
    screenshot_base64: str  # Not available in crawl4ai, will be empty
    title: str
    timestamp: datetime
    state_hash: str = field(init=False)
    
    def __post_init__(self):
        # Create a unique hash for this state based on URL and content
        content = f"{self.url}{self.html}{self.aria_info}"
        self.state_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

@dataclass
class StateTransition:
    """Represents a transition between two states"""
    from_state_hash: str
    to_state_hash: str
    action_type: str  # click, navigate
    element_href: Optional[str] = None
    element_text: Optional[str] = None

class StateGraphCrawlerCrawl4AI:
    def __init__(self, neo4j_uri: str, neo4j_user: str, neo4j_password: str):
        self.driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        self.visited_states: Set[str] = set()
        self.state_queue: List[Tuple[PageState, int]] = []  # (state, depth)
        self.states_map: Dict[str, PageState] = {}  # hash -> state object
        self.transitions: List[StateTransition] = []
        self.max_depth = 3
        self.target_domain = None
        self.crawler = None
        
    def close(self):
        self.driver.close()
        
    async def extract_aria_info(self, html: str) -> str:
        """Extract ARIA information from HTML"""
        soup = BeautifulSoup(html, 'html.parser')
        aria_elements = []
        
        # Find elements with ARIA attributes
        for elem in soup.find_all(attrs=lambda x: x and any(attr.startswith('aria-') for attr in x)):
            elem_info = {
                'tag': elem.name,
                'id': elem.get('id', ''),
                'class': elem.get('class', []),
                'text': elem.get_text(strip=True)[:50] if elem.get_text(strip=True) else '',
                'aria_attrs': {k: v for k, v in elem.attrs.items() if k.startswith('aria-')}
            }
            aria_elements.append(elem_info)
            
        # Find interactive elements
        interactive_tags = ['button', 'a', 'input', 'select', 'textarea']
        for tag in interactive_tags:
            for elem in soup.find_all(tag):
                if elem not in aria_elements:
                    elem_info = {
                        'tag': elem.name,
                        'id': elem.get('id', ''),
                        'href': elem.get('href', ''),
                        'type': elem.get('type', ''),
                        'text': elem.get_text(strip=True)[:50] if elem.get_text(strip=True) else ''
                    }
                    aria_elements.append(elem_info)
                    
        return json.dumps(aria_elements, indent=2)
        
    async def capture_state(self, result) -> PageState:
        """Capture the current state of a page from crawl result"""
        url = result.url
        title = result.metadata.get('title', 'No Title') if result.metadata else 'No Title'
        html = result.html
        
        # Extract ARIA-like information
        aria_info = await self.extract_aria_info(html)
        
        return PageState(
            url=url,
            html=html,
            aria_info=aria_info,
            screenshot_base64="",  # crawl4ai doesn't support screenshots
            title=title,
            timestamp=datetime.now()
        )
    
    async def find_interactive_links(self, html: str, base_url: str) -> List[Dict]:
        """Find all interactive links on the page"""
        soup = BeautifulSoup(html, 'html.parser')
        links = []
        
        # Find all links
        for link in soup.find_all('a', href=True):
            href = link.get('href', '')
            if href and not href.startswith('#'):
                full_url = urljoin(base_url, href)
                # Only include internal links
                if urlparse(full_url).netloc == self.target_domain:
                    links.append({
                        'href': full_url,
                        'text': link.get_text(strip=True)[:50],
                        'action_type': 'navigate'
                    })
                    
        # Find form submit buttons
        for button in soup.find_all(['button', 'input'], type=['submit', 'button']):
            parent_form = button.find_parent('form')
            if parent_form:
                action = parent_form.get('action', '')
                if action:
                    full_url = urljoin(base_url, action)
                    links.append({
                        'href': full_url,
                        'text': button.get_text(strip=True)[:50] or button.get('value', 'Submit'),
                        'action_type': 'submit'
                    })
                    
        return links
    
    async def perform_login(self, start_url: str):
        """Perform login using JavaScript injection"""
        logger.info(f"Attempting login at {start_url}")
        
        js_code = f"""
        // Try to find and fill login form
        const usernameFields = document.querySelectorAll('input[type="text"], input[type="email"], input[name*="user"], input[name*="username"]');
        const passwordFields = document.querySelectorAll('input[type="password"]');
        const submitButtons = document.querySelectorAll('button[type="submit"], input[type="submit"]');
        
        if (usernameFields.length > 0) {{
            usernameFields[0].value = '{LOGIN_USERNAME}';
            usernameFields[0].dispatchEvent(new Event('input', {{ bubbles: true }}));
        }}
        
        if (passwordFields.length > 0) {{
            passwordFields[0].value = '{LOGIN_PASSWORD}';
            passwordFields[0].dispatchEvent(new Event('input', {{ bubbles: true }}));
        }}
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (submitButtons.length > 0) {{
            submitButtons[0].click();
        }}
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        """
        
        config = CrawlerRunConfig(
            js_code=js_code,
            wait_for='body',
            page_timeout=30000,
            verbose=True
        )
        
        result = await self.crawler.arun(start_url, config=config)
        if result.success:
            logger.info("Login attempt completed")
            return result
        else:
            logger.error(f"Login failed: {result.error_message}")
            return None
    
    async def crawl_state_graph(self, start_url: str, max_depth: int = 3):
        """Crawl the state graph of a web application"""
        self.max_depth = max_depth
        self.target_domain = urlparse(start_url).netloc
        
        self.crawler = AsyncWebCrawler(headless=True)
        
        # Perform login if needed
        if LOGIN_USERNAME and LOGIN_PASSWORD:
            login_result = await self.perform_login(start_url)
            if login_result:
                initial_state = await self.capture_state(login_result)
            else:
                # Try without login
                result = await self.crawler.arun(start_url)
                initial_state = await self.capture_state(result)
        else:
            result = await self.crawler.arun(start_url)
            initial_state = await self.capture_state(result)
            
        self.state_queue.append((initial_state, 0))
        self.states_map[initial_state.state_hash] = initial_state
        
        # BFS traversal of states
        while self.state_queue:
            current_state, depth = self.state_queue.pop(0)
            
            if current_state.state_hash in self.visited_states:
                continue
                
            if depth >= self.max_depth:
                continue
            
            self.visited_states.add(current_state.state_hash)
            logger.info(f"Processing state: {current_state.url} (depth: {depth})")
            
            # Find interactive links
            links = await self.find_interactive_links(current_state.html, current_state.url)
            logger.info(f"Found {len(links)} interactive links")
            
            # Process each link
            for link in links[:20]:  # Limit to avoid infinite exploration
                try:
                    target_url = link['href']
                    
                    # Skip if already visited
                    if any(s.url == target_url for s in self.states_map.values()):
                        continue
                    
                    # Fetch the new page
                    result = await self.crawler.arun(target_url)
                    if result.success:
                        new_state = await self.capture_state(result)
                        
                        # Only record if state is new
                        if new_state.state_hash not in self.visited_states:
                            # Record transition
                            transition = StateTransition(
                                from_state_hash=current_state.state_hash,
                                to_state_hash=new_state.state_hash,
                                action_type=link['action_type'],
                                element_href=link['href'],
                                element_text=link['text']
                            )
                            self.transitions.append(transition)
                            
                            # Add to queue
                            self.state_queue.append((new_state, depth + 1))
                            self.states_map[new_state.state_hash] = new_state
                            
                            logger.info(f"Recorded transition: {link['action_type']} to {target_url}")
                            
                except Exception as e:
                    logger.warning(f"Failed to process link {link.get('href', 'unknown')}: {e}")
                    continue
        
        await self.crawler.close()
    
    def save_to_neo4j(self):
        """Save states and transitions to Neo4j"""
        with self.driver.session() as session:
            # Clear existing data
            session.run("MATCH (n) DETACH DELETE n")
            logger.info("Cleared existing graph data")
            
            # Create state nodes
            for state_hash in self.visited_states:
                state_obj = self.states_map.get(state_hash)
                if state_obj:
                    # Store state node
                    session.run("""
                        CREATE (s:State {
                            hash: $hash,
                            url: $url,
                            title: $title,
                            timestamp: $timestamp,
                            domain: $domain
                        })
                    """, 
                    hash=state_obj.state_hash,
                    url=state_obj.url,
                    title=state_obj.title,
                    timestamp=state_obj.timestamp.isoformat(),
                    domain=self.target_domain
                    )
                    
                    # Store content in separate node
                    session.run("""
                        MATCH (s:State {hash: $hash})
                        CREATE (s)-[:HAS_CONTENT]->(c:Content {
                            html: $html,
                            aria_info: $aria
                        })
                    """,
                    hash=state_obj.state_hash,
                    html=state_obj.html[:5000],  # Limit size
                    aria=state_obj.aria_info
                    )
            
            # Create transitions
            for transition in self.transitions:
                session.run("""
                    MATCH (from:State {hash: $from_hash}), (to:State {hash: $to_hash})
                    CREATE (from)-[:TRANSITION {
                        action_type: $action_type,
                        element_href: $href,
                        element_text: $text
                    }]->(to)
                """,
                from_hash=transition.from_state_hash,
                to_hash=transition.to_state_hash,
                action_type=transition.action_type,
                href=transition.element_href or "",
                text=transition.element_text or ""
                )
            
            logger.info(f"Created {len(self.visited_states)} states and {len(self.transitions)} transitions")

async def main():
    """Main execution function"""
    crawler = StateGraphCrawlerCrawl4AI(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    
    try:
        logger.info(f"Starting state graph crawl of {TARGET_URL}")
        await crawler.crawl_state_graph(TARGET_URL, max_depth=3)
        
        # Save to Neo4j
        crawler.save_to_neo4j()
        
        logger.info("Crawl completed successfully!")
        logger.info(f"Visit http://localhost:7474 to view the graph")
        logger.info("Sample queries:")
        logger.info("  MATCH (s:State) RETURN s LIMIT 25")
        logger.info("  MATCH (s1:State)-[t:TRANSITION]->(s2:State) RETURN s1, t, s2 LIMIT 50")
        logger.info("  MATCH (s:State)-[:HAS_CONTENT]->(c:Content) RETURN s, c LIMIT 10")
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())