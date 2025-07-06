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
from playwright.async_api import async_playwright, Page, Browser
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Neo4j configuration
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

# Target site configuration
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
    state_type: str = "page"  # page, channel, dm, settings, profile, etc.
    metadata: Dict = field(default_factory=dict)
    
    def __post_init__(self):
        content = f"{self.url}{self.title}{self.state_type}"
        self.state_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

@dataclass
class StateTransition:
    """Represents a transition between two states"""
    from_state_hash: str
    to_state_hash: str
    action_type: str
    element_selector: Optional[str] = None
    element_text: Optional[str] = None
    element_id: Optional[str] = None

class CompleteRocketChatCrawler:
    def __init__(self, neo4j_uri: str, neo4j_user: str, neo4j_password: str):
        self.driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        self.visited_states: Set[str] = set()
        self.visited_urls: Set[str] = set()
        self.state_queue: List[Tuple[PageState, int]] = []
        self.states_map: Dict[str, PageState] = {}
        self.transitions: List[StateTransition] = []
        self.max_depth = 3
        self.target_domain = None
        
    def close(self):
        self.driver.close()
        
    async def capture_state(self, page: Page, state_type: str = "page") -> PageState:
        """Capture the current state of a page"""
        await page.wait_for_load_state('networkidle')
        await page.wait_for_timeout(1000)  # Extra wait for dynamic content
        
        url = page.url
        title = await page.title()
        
        # Don't capture HTML for large pages
        try:
            html = await page.content()
            if len(html) > 100000:  # Limit HTML size
                html = html[:100000] + "... (truncated)"
        except:
            html = "<error capturing html>"
        
        # Enhanced ARIA snapshot for Rocket.Chat
        aria_snapshot = await page.evaluate("""
            () => {
                const getAllAriaInfo = (element, depth = 0) => {
                    if (!element || depth > 3) return null;
                    
                    const info = {
                        tag: element.tagName?.toLowerCase(),
                        role: element.getAttribute?.('role'),
                        'aria-label': element.getAttribute?.('aria-label'),
                        'data-qa': element.getAttribute?.('data-qa'),
                        id: element.id,
                        className: element.className,
                        textContent: element.textContent?.trim().substring(0, 50)
                    };
                    
                    // Clean up null values
                    Object.keys(info).forEach(key => {
                        if (info[key] === null || info[key] === '' || info[key] === undefined) delete info[key];
                    });
                    
                    return info;
                };
                
                // Rocket.Chat specific elements
                const sidebar = document.querySelector('.sidebar, [data-qa="sidebar"]');
                const mainContent = document.querySelector('.main-content, .rc-old main');
                
                const rcElements = {
                    // Channels
                    channels: Array.from(document.querySelectorAll('[data-qa*="sidebar-item"]:not([data-qa*="direct"])')).map(e => ({
                        name: e.textContent?.trim(),
                        href: e.querySelector('a')?.href
                    })).filter(c => c.name),
                    
                    // Direct messages
                    directMessages: Array.from(document.querySelectorAll('[data-qa*="sidebar-item-direct"], .sidebar-item__wrapper [title]')).map(e => ({
                        name: e.textContent?.trim() || e.getAttribute('title'),
                        href: e.querySelector('a')?.href || e.href
                    })).filter(dm => dm.name && dm.name.includes('_')),
                    
                    // Current room info
                    currentRoom: document.querySelector('.rc-room-header [data-qa="room-title"]')?.textContent || 
                                document.querySelector('[data-qa="room-name"]')?.textContent,
                    
                    // Messages count
                    messagesCount: document.querySelectorAll('[data-qa="message"], .message').length,
                    
                    // User info
                    currentUser: document.querySelector('[data-qa="sidebar-avatar"]')?.getAttribute('title') ||
                                document.querySelector('.avatar')?.getAttribute('title'),
                    
                    // Page structure
                    hasLogin: !!document.querySelector('input[name="emailOrUsername"], .login-form'),
                    hasSidebar: !!sidebar,
                    hasMainContent: !!mainContent,
                    isLoggedIn: !!sidebar && !!mainContent
                };
                
                return JSON.stringify({
                    aria: {
                        sidebar: sidebar ? getAllAriaInfo(sidebar) : null,
                        main: mainContent ? getAllAriaInfo(mainContent) : null
                    },
                    rocketChat: rcElements
                }, null, 2);
            }
        """)
        
        # Take screenshot
        screenshot_bytes = await page.screenshot(full_page=False)  # Don't capture full page
        screenshot_base64 = base64.b64encode(screenshot_bytes).decode('utf-8')[:10000]  # Limit size
        
        # Parse metadata
        try:
            aria_data = json.loads(aria_snapshot)
            metadata = {
                'channels_count': len(aria_data.get('rocketChat', {}).get('channels', [])),
                'dm_count': len(aria_data.get('rocketChat', {}).get('directMessages', [])),
                'messages_count': aria_data.get('rocketChat', {}).get('messagesCount', 0),
                'current_room': aria_data.get('rocketChat', {}).get('currentRoom'),
                'is_logged_in': aria_data.get('rocketChat', {}).get('isLoggedIn', False)
            }
        except:
            metadata = {}
        
        state = PageState(
            url=url,
            html=html,
            aria_snapshot=aria_snapshot,
            screenshot_base64=screenshot_base64,
            title=title,
            timestamp=datetime.now(),
            state_type=state_type,
            metadata=metadata
        )
        
        return state
    
    async def login_to_rocket_chat(self, page: Page) -> bool:
        """Login to Rocket.Chat"""
        logger.info(f"Navigating to {TARGET_URL}")
        await page.goto(TARGET_URL, wait_until='networkidle')
        await page.wait_for_timeout(3000)
        
        # Check if already logged in
        is_logged_in = await page.evaluate("""
            () => !!(document.querySelector('.sidebar') || document.querySelector('.main-content'))
        """)
        
        if is_logged_in:
            logger.info("Already logged in")
            return True
        
        logger.info("Filling login form")
        try:
            # Fill username
            await page.fill('input[name="emailOrUsername"]', LOGIN_USERNAME)
            logger.info("Username filled")
            
            # Fill password
            await page.fill('input[type="password"]', LOGIN_PASSWORD)
            logger.info("Password filled")
            
            # Click login
            await page.click('button.login')
            logger.info("Login button clicked")
            
            # Wait for login to complete
            await page.wait_for_timeout(10000)
            
            # Verify login
            is_logged_in = await page.evaluate("""
                () => !!(document.querySelector('.sidebar') || document.querySelector('.main-content'))
            """)
            
            if is_logged_in:
                logger.info("Login successful!")
                return True
            else:
                logger.error("Login failed - still showing login form")
                return False
                
        except Exception as e:
            logger.error(f"Login error: {e}")
            return False
    
    async def find_rocket_chat_elements(self, page: Page) -> List[Dict]:
        """Find all interactive elements in Rocket.Chat"""
        elements = await page.evaluate("""
            () => {
                const interactiveElements = [];
                
                // Get all channel links
                const channelLinks = document.querySelectorAll('.sidebar a[href*="/channel/"]');
                channelLinks.forEach(link => {
                    const href = link.getAttribute('href');
                    const text = link.textContent?.trim();
                    if (href && text) {
                        interactiveElements.push({
                            selector: `a[href="${href}"]`,
                            text: `Channel: ${text}`,
                            href: link.href,
                            type: 'channel',
                            actionType: 'navigate'
                        });
                    }
                });
                
                // Get all direct message links
                const dmLinks = document.querySelectorAll('.sidebar a[href*="/direct/"]');
                dmLinks.forEach(link => {
                    const href = link.getAttribute('href');
                    const text = link.textContent?.trim();
                    if (href && text) {
                        interactiveElements.push({
                            selector: `a[href="${href}"]`,
                            text: `DM: ${text}`,
                            href: link.href,
                            type: 'dm',
                            actionType: 'navigate'
                        });
                    }
                });
                
                // Get header buttons
                const headerButtons = document.querySelectorAll('.rc-room-header button, header button');
                headerButtons.forEach((btn, idx) => {
                    const text = btn.getAttribute('aria-label') || btn.textContent?.trim();
                    if (text && text.length < 50) {
                        interactiveElements.push({
                            selector: `header button:nth-of-type(${idx + 1})`,
                            text: text,
                            type: 'header-button',
                            actionType: 'click'
                        });
                    }
                });
                
                // Get sidebar menu items
                const menuItems = document.querySelectorAll('[data-qa*="sidebar"][data-qa*="button"], .sidebar-item__menu');
                menuItems.forEach(item => {
                    const text = item.getAttribute('aria-label') || item.textContent?.trim();
                    if (text) {
                        interactiveElements.push({
                            selector: `[data-qa="${item.getAttribute('data-qa')}"]`,
                            text: text,
                            type: 'menu',
                            actionType: 'click'
                        });
                    }
                });
                
                // Home and other navigation
                const navLinks = document.querySelectorAll('a[href="/home"], a[href="/account"], a[href="/admin"]');
                navLinks.forEach(link => {
                    interactiveElements.push({
                        selector: `a[href="${link.getAttribute('href')}"]`,
                        text: link.textContent?.trim() || 'Navigation',
                        href: link.href,
                        type: 'navigation',
                        actionType: 'navigate'
                    });
                });
                
                return interactiveElements.filter(e => e.text && e.text.length > 0);
            }
        """)
        
        logger.info(f"Found {len(elements)} interactive elements")
        return elements
    
    async def crawl_rocket_chat(self, start_url: str, max_depth: int = 3):
        """Main crawling function"""
        self.max_depth = max_depth
        self.target_domain = urlparse(start_url).netloc
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,  # Set to False for debugging
                args=['--disable-blink-features=AutomationControlled']
            )
            
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 720},
                ignore_https_errors=True
            )
            
            page = await context.new_page()
            
            # Login
            if not await self.login_to_rocket_chat(page):
                logger.error("Failed to login")
                await browser.close()
                return
            
            # Capture initial state
            initial_state = await self.capture_state(page, state_type="home")
            self.state_queue.append((initial_state, 0))
            self.states_map[initial_state.state_hash] = initial_state
            self.visited_urls.add(initial_state.url)
            
            # BFS traversal
            processed_count = 0
            max_states = 20  # Limit total states
            
            while self.state_queue and processed_count < max_states:
                current_state, depth = self.state_queue.pop(0)
                
                if current_state.state_hash in self.visited_states:
                    continue
                    
                if depth >= self.max_depth:
                    continue
                
                self.visited_states.add(current_state.state_hash)
                processed_count += 1
                
                logger.info(f"Processing state {processed_count}/{max_states}: {current_state.state_type} - {current_state.url[:50]} (depth: {depth})")
                
                # Navigate to state if needed
                if page.url != current_state.url:
                    try:
                        await page.goto(current_state.url, wait_until='networkidle', timeout=30000)
                        await page.wait_for_timeout(2000)
                    except:
                        logger.warning(f"Failed to navigate to {current_state.url}")
                        continue
                
                # Find interactive elements
                elements = await self.find_rocket_chat_elements(page)
                
                # Process elements (limit per page)
                for i, element in enumerate(elements[:10]):
                    try:
                        # Skip if URL already visited
                        if element.get('href') and element['href'] in self.visited_urls:
                            continue
                        
                        logger.info(f"  Trying element {i+1}: {element['type']} - {element['text'][:30]}")
                        
                        before_url = page.url
                        
                        # Perform action
                        if element['actionType'] == 'navigate' and element.get('href'):
                            await page.goto(element['href'], wait_until='networkidle', timeout=20000)
                            await page.wait_for_timeout(2000)
                        else:
                            # Click action
                            try:
                                await page.click(element['selector'], timeout=5000)
                                await page.wait_for_timeout(3000)
                            except:
                                logger.warning(f"    Failed to click {element['selector']}")
                                continue
                        
                        # Check if state changed
                        after_url = page.url
                        if after_url != before_url or element['actionType'] == 'click':
                            # Capture new state
                            new_state = await self.capture_state(page, state_type=element['type'])
                            
                            # Only add if truly new
                            if new_state.state_hash not in self.visited_states:
                                # Record transition
                                transition = StateTransition(
                                    from_state_hash=current_state.state_hash,
                                    to_state_hash=new_state.state_hash,
                                    action_type=element['actionType'],
                                    element_selector=element.get('selector'),
                                    element_text=element['text'][:50]
                                )
                                self.transitions.append(transition)
                                
                                # Add to queue
                                self.state_queue.append((new_state, depth + 1))
                                self.states_map[new_state.state_hash] = new_state
                                self.visited_urls.add(new_state.url)
                                
                                logger.info(f"    ✓ Recorded transition to {new_state.state_type}")
                            
                            # Navigate back if needed
                            if page.url != current_state.url and depth < self.max_depth - 1:
                                try:
                                    await page.goto(current_state.url, wait_until='networkidle', timeout=20000)
                                    await page.wait_for_timeout(2000)
                                except:
                                    logger.warning("    Failed to navigate back")
                                    break
                        
                    except Exception as e:
                        logger.error(f"    Error processing element: {e}")
                        continue
            
            # Final screenshot
            await page.screenshot(path="final_crawl_complete.png")
            logger.info(f"Crawl complete. Processed {processed_count} states")
            
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
                    session.run("""
                        CREATE (s:State {
                            hash: $hash,
                            url: $url,
                            title: $title,
                            timestamp: $timestamp,
                            domain: $domain,
                            state_type: $state_type,
                            channels_count: $channels,
                            dm_count: $dms,
                            messages_count: $messages,
                            current_room: $room,
                            is_logged_in: $logged_in
                        })
                    """, 
                    hash=state_obj.state_hash,
                    url=state_obj.url,
                    title=state_obj.title,
                    timestamp=state_obj.timestamp.isoformat(),
                    domain=self.target_domain,
                    state_type=state_obj.state_type,
                    channels=state_obj.metadata.get('channels_count', 0),
                    dms=state_obj.metadata.get('dm_count', 0),
                    messages=state_obj.metadata.get('messages_count', 0),
                    room=state_obj.metadata.get('current_room', ''),
                    logged_in=state_obj.metadata.get('is_logged_in', False)
                    )
                    
                    # Store content
                    session.run("""
                        MATCH (s:State {hash: $hash})
                        CREATE (s)-[:HAS_CONTENT]->(c:Content {
                            aria_snapshot: $aria,
                            screenshot_sample: $screenshot
                        })
                    """,
                    hash=state_obj.state_hash,
                    aria=state_obj.aria_snapshot[:5000],  # Limit size
                    screenshot=state_obj.screenshot_base64[:1000]  # Just a sample
                    )
            
            # Create transitions
            for transition in self.transitions:
                session.run("""
                    MATCH (from:State {hash: $from_hash}), (to:State {hash: $to_hash})
                    CREATE (from)-[:TRANSITION {
                        action_type: $action_type,
                        element_selector: $selector,
                        element_text: $text
                    }]->(to)
                """,
                from_hash=transition.from_state_hash,
                to_hash=transition.to_state_hash,
                action_type=transition.action_type,
                selector=transition.element_selector or "",
                text=transition.element_text or ""
                )
            
            # Log summary
            result = session.run("""
                MATCH (s:State)
                WITH s.state_type as type, count(s) as count
                RETURN type, count
                ORDER BY count DESC
            """)
            
            logger.info("\nState type summary:")
            for record in result:
                logger.info(f"  {record['type']}: {record['count']}")
            
            logger.info(f"\nTotal: {len(self.visited_states)} states and {len(self.transitions)} transitions")

async def main():
    """Main execution function"""
    crawler = CompleteRocketChatCrawler(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    
    try:
        logger.info(f"Starting complete Rocket.Chat crawl of {TARGET_URL}")
        await crawler.crawl_rocket_chat(TARGET_URL, max_depth=2)
        
        # Save to Neo4j
        crawler.save_to_neo4j()
        
        logger.info("\nCrawl completed successfully!")
        logger.info(f"Visit http://localhost:7474 to view the graph")
        logger.info("\nSample queries:")
        logger.info("  MATCH (s:State) RETURN s")
        logger.info("  MATCH (s:State {state_type: 'channel'}) RETURN s")
        logger.info("  MATCH (s:State {state_type: 'dm'}) RETURN s")
        logger.info("  MATCH path = (s1:State)-[:TRANSITION*]->(s2:State) RETURN path LIMIT 10")
        logger.info("  MATCH (s:State)-[t:TRANSITION]->(s2:State) RETURN s.state_type, t.element_text, s2.state_type")
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())