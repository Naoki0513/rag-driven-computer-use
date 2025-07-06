import asyncio
import sys
import json
import base64
from datetime import datetime
from urllib.parse import urlparse, urljoin
from typing import Dict, List, Set, Optional, Tuple
from dataclasses import dataclass, field
import hashlib

from neo4j import GraphDatabase
from playwright.async_api import async_playwright, Page, Browser
import logging

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
    aria_snapshot: str
    screenshot_base64: str
    title: str
    timestamp: datetime
    state_hash: str = field(init=False)
    
    def __post_init__(self):
        # Create a unique hash for this state based on URL and content
        content = f"{self.url}{self.html}{self.aria_snapshot}"
        self.state_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

@dataclass
class StateTransition:
    """Represents a transition between two states"""
    from_state_hash: str
    to_state_hash: str
    action_type: str  # click, submit, navigate, etc.
    element_selector: Optional[str] = None
    element_text: Optional[str] = None
    element_id: Optional[str] = None

class StateGraphCrawler:
    def __init__(self, neo4j_uri: str, neo4j_user: str, neo4j_password: str):
        self.driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        self.visited_states: Set[str] = set()
        self.state_queue: List[Tuple[PageState, int]] = []  # (state, depth)
        self.states_map: Dict[str, PageState] = {}  # hash -> state object
        self.transitions: List[StateTransition] = []
        self.max_depth = 3
        self.target_domain = None
        
    def close(self):
        self.driver.close()
        
    async def capture_state(self, page: Page) -> PageState:
        """Capture the current state of a page"""
        # Get page content
        url = page.url
        title = await page.title()
        html = await page.content()
        
        # Get ARIA snapshot
        aria_snapshot = await page.evaluate("""
            () => {
                const getAllAriaInfo = (element, depth = 0) => {
                    const info = {
                        tag: element.tagName.toLowerCase(),
                        role: element.getAttribute('role'),
                        'aria-label': element.getAttribute('aria-label'),
                        'aria-labelledby': element.getAttribute('aria-labelledby'),
                        'aria-describedby': element.getAttribute('aria-describedby'),
                        'aria-hidden': element.getAttribute('aria-hidden'),
                        id: element.id,
                        className: element.className,
                        textContent: element.textContent?.trim().substring(0, 100),
                        children: []
                    };
                    
                    // Clean up null values
                    Object.keys(info).forEach(key => {
                        if (info[key] === null || info[key] === '') delete info[key];
                    });
                    
                    // Get children recursively (limit depth to avoid huge snapshots)
                    if (depth < 5) {
                        for (const child of element.children) {
                            info.children.push(getAllAriaInfo(child, depth + 1));
                        }
                    }
                    
                    return info;
                };
                
                return JSON.stringify(getAllAriaInfo(document.body), null, 2);
            }
        """)
        
        # Take screenshot
        screenshot_bytes = await page.screenshot(full_page=True)
        screenshot_base64 = base64.b64encode(screenshot_bytes).decode('utf-8')
        
        return PageState(
            url=url,
            html=html,
            aria_snapshot=aria_snapshot,
            screenshot_base64=screenshot_base64,
            title=title,
            timestamp=datetime.now()
        )
    
    async def find_interactive_elements(self, page: Page) -> List[Dict]:
        """Find all interactive elements on the page"""
        # Wait for page to be fully loaded
        await page.wait_for_load_state('networkidle')
        
        elements = await page.evaluate("""
            () => {
                const interactiveElements = [];
                const processedElements = new Set();
                
                // Find all links
                const links = document.querySelectorAll('a');
                links.forEach((element) => {
                    const href = element.getAttribute('href');
                    if (href && !href.startsWith('javascript:') && !processedElements.has(element)) {
                        processedElements.add(element);
                        
                        // Skip hidden elements
                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        
                        if (rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            parseFloat(style.opacity) > 0) {
                            
                            // Create selector
                            let selector = 'a';
                            if (element.id) {
                                selector = `#${element.id}`;
                            } else if (element.className) {
                                selector = `a.${element.className.split(' ')[0]}`;
                            } else if (element.textContent) {
                                selector = `a:text("${element.textContent.trim().substring(0, 20)}")`;
                            }
                            
                            interactiveElements.push({
                                selector: selector,
                                text: element.textContent?.trim().substring(0, 50) || '',
                                id: element.id || null,
                                href: href,
                                type: 'link',
                                actionType: 'navigate'
                            });
                        }
                    }
                });
                
                // Find all buttons
                const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
                buttons.forEach((element) => {
                    if (!processedElements.has(element)) {
                        processedElements.add(element);
                        
                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        
                        if (rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            parseFloat(style.opacity) > 0) {
                            
                            let selector = element.tagName.toLowerCase();
                            if (element.id) {
                                selector = `#${element.id}`;
                            } else if (element.className) {
                                selector = `${element.tagName.toLowerCase()}.${element.className.split(' ')[0]}`;
                            } else if (element.textContent) {
                                selector = `${element.tagName.toLowerCase()}:text("${element.textContent.trim().substring(0, 20)}")`;
                            }
                            
                            interactiveElements.push({
                                selector: selector,
                                text: element.textContent?.trim() || element.value || '',
                                id: element.id || null,
                                href: null,
                                type: 'button',
                                actionType: 'click'
                            });
                        }
                    }
                });
                
                console.log('Found interactive elements:', interactiveElements.length);
                return interactiveElements;
            }
        """)
        
        # Log found elements for debugging
        logger.info(f"Raw interactive elements found: {len(elements)}")
        if elements:
            logger.info(f"Sample elements: {elements[:3]}")
        
        return elements
    
    async def perform_login(self, page: Page, login_url: str):
        """Perform login if credentials are provided"""
        logger.info(f"Attempting login at {login_url}")
        
        await page.goto(login_url, wait_until='networkidle')
        
        # Try to find and fill login form
        try:
            # More specific selectors for the-agent-company.com
            username_selectors = [
                'input[name="username"]',
                'input[name="user"]', 
                'input[type="text"]',
                'input[type="email"]',
                'input[placeholder*="user" i]',
                'input[placeholder*="name" i]'
            ]
            
            password_selectors = [
                'input[type="password"]',
                'input[name="password"]',
                'input[placeholder*="pass" i]'
            ]
            
            # Try username fields
            username_filled = False
            for selector in username_selectors:
                try:
                    username_field = await page.query_selector(selector)
                    if username_field:
                        await username_field.fill(LOGIN_USERNAME)
                        username_filled = True
                        logger.info(f"Filled username field with selector: {selector}")
                        break
                except:
                    continue
                    
            # Try password fields
            password_filled = False
            for selector in password_selectors:
                try:
                    password_field = await page.query_selector(selector)
                    if password_field:
                        await password_field.fill(LOGIN_PASSWORD)
                        password_filled = True
                        logger.info(f"Filled password field with selector: {selector}")
                        break
                except:
                    continue
            
            if username_filled and password_filled:
                # Try various submit methods
                submit_selectors = [
                    'button[type="submit"]',
                    'input[type="submit"]',
                    'button:has-text("Login")',
                    'button:has-text("Sign in")',
                    'button:has-text("Submit")',
                    'form button'
                ]
                
                for selector in submit_selectors:
                    try:
                        submit_button = await page.query_selector(selector)
                        if submit_button:
                            await submit_button.click()
                            logger.info(f"Clicked submit button with selector: {selector}")
                            await page.wait_for_load_state('networkidle', timeout=10000)
                            break
                    except:
                        continue
                        
                # Alternative: submit by pressing Enter
                if password_field:
                    await password_field.press('Enter')
                    logger.info("Submitted form by pressing Enter")
                    await page.wait_for_load_state('networkidle', timeout=10000)
                    
            else:
                logger.warning(f"Could not fill login form - username: {username_filled}, password: {password_filled}")
                
        except Exception as e:
            logger.error(f"Login failed: {e}")
    
    async def crawl_state_graph(self, start_url: str, max_depth: int = 3):
        """Crawl the state graph of a web application"""
        self.max_depth = max_depth
        self.target_domain = urlparse(start_url).netloc
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 720},
                ignore_https_errors=True
            )
            page = await context.new_page()
            
            # Perform login if needed
            if LOGIN_USERNAME and LOGIN_PASSWORD:
                await self.perform_login(page, start_url)
                # Take screenshot after login for debugging
                await page.screenshot(path="after_login.png")
                logger.info(f"Screenshot saved to after_login.png")
                logger.info(f"Current URL after login: {page.url}")
            else:
                await page.goto(start_url, wait_until='networkidle')
            
            # Capture initial state
            initial_state = await self.capture_state(page)
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
                
                # Navigate to this state if needed
                if page.url != current_state.url:
                    await page.goto(current_state.url, wait_until='networkidle')
                
                # Find interactive elements
                elements = await self.find_interactive_elements(page)
                logger.info(f"Found {len(elements)} interactive elements")
                
                # Try interacting with each element
                for element in elements[:10]:  # Limit to avoid infinite exploration
                    try:
                        # Save current state before interaction
                        before_url = page.url
                        
                        # Perform interaction based on type
                        if element['actionType'] == 'navigate' and element['href']:
                            # Check if it's an internal link
                            target_url = urljoin(before_url, element['href'])
                            if urlparse(target_url).netloc == self.target_domain:
                                await page.goto(target_url, wait_until='networkidle')
                        else:
                            # Click the element
                            try:
                                await page.click(element['selector'], timeout=5000)
                                await page.wait_for_load_state('networkidle', timeout=5000)
                            except:
                                continue
                        
                        # Capture new state
                        new_state = await self.capture_state(page)
                        
                        # Only record if state changed
                        if new_state.state_hash != current_state.state_hash:
                            # Record transition
                            transition = StateTransition(
                                from_state_hash=current_state.state_hash,
                                to_state_hash=new_state.state_hash,
                                action_type=element['actionType'],
                                element_selector=element['selector'],
                                element_text=element['text'],
                                element_id=element['id']
                            )
                            self.transitions.append(transition)
                            
                            # Add to queue if not visited
                            if new_state.state_hash not in self.visited_states:
                                self.state_queue.append((new_state, depth + 1))
                                self.states_map[new_state.state_hash] = new_state
                            
                            logger.info(f"Recorded transition: {element['actionType']} on {element['text']}")
                        
                        # Go back to original state for next interaction
                        if page.url != current_state.url:
                            await page.goto(current_state.url, wait_until='networkidle')
                            
                    except Exception as e:
                        logger.warning(f"Failed to interact with element {element['selector']}: {e}")
                        continue
            
            await browser.close()
    
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
                    # Store large data separately and just reference it in the main node
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
                    
                    # Store full content in separate nodes
                    session.run("""
                        MATCH (s:State {hash: $hash})
                        CREATE (s)-[:HAS_CONTENT]->(c:Content {
                            html: $html,
                            aria_snapshot: $aria,
                            screenshot: $screenshot
                        })
                    """,
                    hash=state_obj.state_hash,
                    html=state_obj.html,
                    aria=state_obj.aria_snapshot,
                    screenshot=state_obj.screenshot_base64
                    )
            
            # Create transitions
            for transition in self.transitions:
                session.run("""
                    MATCH (from:State {hash: $from_hash}), (to:State {hash: $to_hash})
                    CREATE (from)-[:TRANSITION {
                        action_type: $action_type,
                        element_selector: $selector,
                        element_text: $text,
                        element_id: $element_id
                    }]->(to)
                """,
                from_hash=transition.from_state_hash,
                to_hash=transition.to_state_hash,
                action_type=transition.action_type,
                selector=transition.element_selector or "",
                text=transition.element_text or "",
                element_id=transition.element_id or ""
                )
            
            logger.info(f"Created {len(self.visited_states)} states and {len(self.transitions)} transitions")

async def main():
    """Main execution function"""
    crawler = StateGraphCrawler(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    
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
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())