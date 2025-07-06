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
import requests
import time

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
    state_type: str = "page"  # page, channel, settings, profile, etc.
    
    def __post_init__(self):
        content = f"{self.url}{self.html}{self.aria_snapshot}"
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

class RocketChatAPICrawler:
    def __init__(self, neo4j_uri: str, neo4j_user: str, neo4j_password: str):
        self.driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        self.visited_states: Set[str] = set()
        self.state_queue: List[Tuple[PageState, int]] = []
        self.states_map: Dict[str, PageState] = {}
        self.transitions: List[StateTransition] = []
        self.max_depth = 3
        self.target_domain = None
        self.auth_token = None
        self.user_id = None
        
    def close(self):
        self.driver.close()
    
    def api_login(self, base_url: str) -> bool:
        """Login using Rocket.Chat REST API"""
        login_url = f"{base_url}/api/v1/login"
        
        try:
            response = requests.post(login_url, json={
                "user": LOGIN_USERNAME,
                "password": LOGIN_PASSWORD
            })
            
            if response.status_code == 200:
                data = response.json()
                self.auth_token = data['data']['authToken']
                self.user_id = data['data']['userId']
                logger.info(f"API login successful! User ID: {self.user_id}")
                return True
            else:
                logger.error(f"API login failed: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            logger.error(f"API login error: {e}")
            return False
    
    def get_channels(self, base_url: str) -> List[Dict]:
        """Get list of channels via API"""
        if not self.auth_token:
            return []
            
        try:
            response = requests.get(
                f"{base_url}/api/v1/channels.list",
                headers={
                    "X-Auth-Token": self.auth_token,
                    "X-User-Id": self.user_id
                }
            )
            
            if response.status_code == 200:
                channels = response.json().get('channels', [])
                logger.info(f"Found {len(channels)} channels via API")
                return channels
            else:
                logger.error(f"Failed to get channels: {response.status_code}")
                return []
                
        except Exception as e:
            logger.error(f"Error getting channels: {e}")
            return []
        
    async def capture_state(self, page: Page, state_type: str = "page") -> PageState:
        """Capture the current state of a page"""
        await page.wait_for_load_state('networkidle')
        await page.wait_for_timeout(2000)  # Extra wait for dynamic content
        
        url = page.url
        title = await page.title()
        html = await page.content()
        
        # Enhanced ARIA snapshot
        aria_snapshot = await page.evaluate("""
            () => {
                const getAllAriaInfo = (element, depth = 0) => {
                    const info = {
                        tag: element.tagName.toLowerCase(),
                        role: element.getAttribute('role'),
                        'aria-label': element.getAttribute('aria-label'),
                        'data-qa': element.getAttribute('data-qa'),
                        'data-qa-id': element.getAttribute('data-qa-id'),
                        id: element.id,
                        className: element.className,
                        textContent: element.textContent?.trim().substring(0, 100),
                        children: []
                    };
                    
                    Object.keys(info).forEach(key => {
                        if (info[key] === null || info[key] === '') delete info[key];
                    });
                    
                    if (depth < 5 && element.children.length < 20) {
                        for (const child of element.children) {
                            info.children.push(getAllAriaInfo(child, depth + 1));
                        }
                    }
                    
                    return info;
                };
                
                // Rocket.Chat specific elements
                const rcElements = {
                    channels: Array.from(document.querySelectorAll('[data-qa*="sidebar-item"]')).map(e => ({
                        text: e.textContent,
                        href: e.querySelector('a')?.href
                    })),
                    messages: document.querySelectorAll('[data-qa="message"]').length,
                    users: Array.from(document.querySelectorAll('[data-qa*="user"]')).map(e => e.textContent),
                    isLoggedIn: !!document.querySelector('.rc-old, .main-content, [data-qa="home-body"]')
                };
                
                return JSON.stringify({
                    aria: getAllAriaInfo(document.body),
                    rocketChat: rcElements
                }, null, 2);
            }
        """)
        
        screenshot_bytes = await page.screenshot(full_page=True)
        screenshot_base64 = base64.b64encode(screenshot_bytes).decode('utf-8')
        
        state = PageState(
            url=url,
            html=html,
            aria_snapshot=aria_snapshot,
            screenshot_base64=screenshot_base64,
            title=title,
            timestamp=datetime.now(),
            state_type=state_type
        )
        
        return state
    
    async def login_with_cookies(self, page: Page, base_url: str) -> bool:
        """Login by setting cookies obtained from API"""
        if not self.auth_token:
            return False
            
        # Set auth cookies
        await page.context.add_cookies([
            {
                'name': 'rc_token',
                'value': self.auth_token,
                'domain': urlparse(base_url).hostname,
                'path': '/'
            },
            {
                'name': 'rc_uid',
                'value': self.user_id,
                'domain': urlparse(base_url).hostname,
                'path': '/'
            }
        ])
        
        # Navigate to main page
        await page.goto(base_url, wait_until='networkidle')
        await page.wait_for_timeout(5000)
        
        # Check if logged in
        is_logged_in = await page.evaluate("""
            () => {
                return !!(document.querySelector('.rc-old') || 
                         document.querySelector('.main-content') ||
                         document.querySelector('[data-qa="home-body"]') ||
                         document.querySelector('.sidebar'));
            }
        """)
        
        return is_logged_in
    
    async def find_interactive_elements(self, page: Page) -> List[Dict]:
        """Find interactive elements on the page"""
        elements = await page.evaluate("""
            () => {
                const interactiveElements = [];
                
                // Channels in sidebar
                const channels = document.querySelectorAll('[data-qa*="sidebar-item"] a, .sidebar-item a');
                channels.forEach(elem => {
                    if (elem.href && !elem.href.includes('#')) {
                        interactiveElements.push({
                            selector: `a[href="${elem.getAttribute('href')}"]`,
                            text: elem.textContent?.trim() || 'Channel',
                            href: elem.href,
                            type: 'channel',
                            actionType: 'navigate'
                        });
                    }
                });
                
                // User menu items
                const userMenuItems = document.querySelectorAll('[data-qa*="user-menu"], [data-qa*="account"]');
                userMenuItems.forEach(elem => {
                    interactiveElements.push({
                        selector: `[data-qa="${elem.getAttribute('data-qa')}"]`,
                        text: elem.textContent?.trim() || 'Menu',
                        type: 'menu',
                        actionType: 'click'
                    });
                });
                
                // Settings and options
                const settingsLinks = document.querySelectorAll('a[href*="account"], a[href*="preferences"]');
                settingsLinks.forEach(elem => {
                    if (elem.href) {
                        interactiveElements.push({
                            selector: `a[href="${elem.getAttribute('href')}"]`,
                            text: elem.textContent?.trim() || 'Settings',
                            href: elem.href,
                            type: 'settings',
                            actionType: 'navigate'
                        });
                    }
                });
                
                // General buttons
                const buttons = document.querySelectorAll('button:not([disabled]), [role="button"]');
                buttons.forEach((elem, idx) => {
                    const text = elem.textContent?.trim();
                    if (text && text.length > 1 && text.length < 50) {
                        interactiveElements.push({
                            selector: `button:nth-of-type(${idx + 1})`,
                            text: text,
                            type: 'button',
                            actionType: 'click'
                        });
                    }
                });
                
                // Remove duplicates
                const seen = new Set();
                return interactiveElements.filter(elem => {
                    const key = elem.selector + elem.text;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            }
        """)
        
        logger.info(f"Found {len(elements)} interactive elements")
        return elements
    
    async def crawl_rocket_chat_with_api(self, start_url: str, max_depth: int = 3):
        """Crawl Rocket.Chat using API for authentication"""
        self.max_depth = max_depth
        self.target_domain = urlparse(start_url).netloc
        
        # First, login via API
        if not self.api_login(start_url):
            logger.error("API login failed, trying browser-based approach")
            
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=False,  # Set to False for debugging
                args=['--disable-blink-features=AutomationControlled']
            )
            
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 720},
                ignore_https_errors=True,
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            )
            
            page = await context.new_page()
            
            # Enable console logging
            page.on("console", lambda msg: logger.info(f"Browser console: {msg.text}"))
            
            # Try to login with cookies if we have auth token
            login_success = False
            if self.auth_token:
                logger.info("Attempting cookie-based login")
                login_success = await self.login_with_cookies(page, start_url)
                
            if not login_success:
                logger.info("Cookie login failed, trying direct navigation")
                # Try direct navigation
                await page.goto(f"{start_url}/channel/general", wait_until='networkidle')
                await page.wait_for_timeout(5000)
                
                # Check if we're redirected to login
                if "/home" in page.url or "login" in page.url:
                    logger.error("Still on login page, cannot proceed")
                    await page.screenshot(path="final_login_state.png")
                    await browser.close()
                    return
            
            # Take screenshot of current state
            await page.screenshot(path="after_api_login.png")
            logger.info(f"Current URL: {page.url}")
            
            # Get channels from API if available
            if self.auth_token:
                channels = self.get_channels(start_url)
                logger.info(f"Available channels from API: {[c['name'] for c in channels[:5]]}")
            
            # Capture initial state
            initial_state = await self.capture_state(page, state_type="main")
            self.state_queue.append((initial_state, 0))
            self.states_map[initial_state.state_hash] = initial_state
            
            # Parse ARIA snapshot to check login status
            aria_data = json.loads(initial_state.aria_snapshot)
            is_logged_in = aria_data.get('rocketChat', {}).get('isLoggedIn', False)
            logger.info(f"Login status from page: {is_logged_in}")
            
            if not is_logged_in:
                logger.error("Not logged in according to page analysis")
                await browser.close()
                return
            
            # BFS traversal
            processed_count = 0
            while self.state_queue and processed_count < 15:
                current_state, depth = self.state_queue.pop(0)
                
                if current_state.state_hash in self.visited_states:
                    continue
                    
                if depth >= self.max_depth:
                    continue
                
                self.visited_states.add(current_state.state_hash)
                processed_count += 1
                
                logger.info(f"Processing state {processed_count}: {current_state.url} (depth: {depth})")
                
                # Navigate to state if needed
                if page.url != current_state.url:
                    await page.goto(current_state.url, wait_until='networkidle')
                    await page.wait_for_timeout(2000)
                
                # Find interactive elements
                elements = await self.find_interactive_elements(page)
                
                # Try channels from API first if available
                if self.auth_token and depth == 0:
                    for channel in channels[:5]:
                        channel_url = f"{start_url}/channel/{channel['name']}"
                        logger.info(f"Trying API channel: {channel['name']}")
                        
                        try:
                            await page.goto(channel_url, wait_until='networkidle')
                            await page.wait_for_timeout(2000)
                            
                            new_state = await self.capture_state(page, state_type="channel")
                            
                            if new_state.state_hash not in self.visited_states:
                                transition = StateTransition(
                                    from_state_hash=current_state.state_hash,
                                    to_state_hash=new_state.state_hash,
                                    action_type="navigate",
                                    element_text=f"Channel: {channel['name']}"
                                )
                                self.transitions.append(transition)
                                self.state_queue.append((new_state, depth + 1))
                                self.states_map[new_state.state_hash] = new_state
                                
                        except Exception as e:
                            logger.error(f"Error navigating to channel {channel['name']}: {e}")
                
                # Process found elements
                for i, element in enumerate(elements[:5]):
                    try:
                        logger.info(f"Trying element {i+1}: {element['type']} - {element['text']}")
                        
                        before_url = page.url
                        
                        if element['actionType'] == 'navigate' and element.get('href'):
                            target_url = element['href']
                            if urlparse(target_url).netloc == self.target_domain:
                                await page.goto(target_url, wait_until='networkidle')
                                await page.wait_for_timeout(2000)
                        else:
                            try:
                                await page.click(element['selector'], timeout=5000)
                                await page.wait_for_timeout(2000)
                            except:
                                continue
                        
                        new_state = await self.capture_state(page, state_type=element['type'])
                        
                        if new_state.state_hash != current_state.state_hash:
                            transition = StateTransition(
                                from_state_hash=current_state.state_hash,
                                to_state_hash=new_state.state_hash,
                                action_type=element['actionType'],
                                element_selector=element['selector'],
                                element_text=element['text']
                            )
                            self.transitions.append(transition)
                            
                            if new_state.state_hash not in self.visited_states:
                                self.state_queue.append((new_state, depth + 1))
                                self.states_map[new_state.state_hash] = new_state
                            
                            logger.info(f"Recorded transition: {element['actionType']} on {element['text']}")
                            
                            # Go back if needed
                            if page.url != current_state.url:
                                await page.goto(current_state.url, wait_until='networkidle')
                                await page.wait_for_timeout(2000)
                        
                    except Exception as e:
                        logger.error(f"Error processing element: {e}")
                        continue
            
            # Final screenshot
            await page.screenshot(path="final_crawl_state.png")
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
                    # Parse ARIA data to get Rocket.Chat specific info
                    aria_data = json.loads(state_obj.aria_snapshot)
                    rc_data = aria_data.get('rocketChat', {})
                    
                    session.run("""
                        CREATE (s:State {
                            hash: $hash,
                            url: $url,
                            title: $title,
                            timestamp: $timestamp,
                            domain: $domain,
                            state_type: $state_type,
                            channel_count: $channels,
                            message_count: $messages,
                            is_logged_in: $logged_in
                        })
                    """, 
                    hash=state_obj.state_hash,
                    url=state_obj.url,
                    title=state_obj.title,
                    timestamp=state_obj.timestamp.isoformat(),
                    domain=self.target_domain,
                    state_type=state_obj.state_type,
                    channels=len(rc_data.get('channels', [])),
                    messages=rc_data.get('messages', 0),
                    logged_in=rc_data.get('isLoggedIn', False)
                    )
                    
                    # Store content
                    session.run("""
                        MATCH (s:State {hash: $hash})
                        CREATE (s)-[:HAS_CONTENT]->(c:Content {
                            html: $html,
                            aria_snapshot: $aria,
                            screenshot: $screenshot
                        })
                    """,
                    hash=state_obj.state_hash,
                    html=state_obj.html[:5000],
                    aria=state_obj.aria_snapshot,
                    screenshot=state_obj.screenshot_base64[:1000]
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
    crawler = RocketChatAPICrawler(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    
    try:
        logger.info(f"Starting Rocket.Chat API-based crawl of {TARGET_URL}")
        await crawler.crawl_rocket_chat_with_api(TARGET_URL, max_depth=3)
        
        # Save to Neo4j
        crawler.save_to_neo4j()
        
        logger.info("Crawl completed successfully!")
        logger.info(f"Visit http://localhost:7474 to view the graph")
        logger.info("Sample queries:")
        logger.info("  MATCH (s:State) RETURN s")
        logger.info("  MATCH (s:State {is_logged_in: true}) RETURN s")
        logger.info("  MATCH (s1:State)-[t:TRANSITION]->(s2:State) RETURN s1, t, s2")
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())