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

class RocketChatCrawler:
    def __init__(self, neo4j_uri: str, neo4j_user: str, neo4j_password: str):
        self.driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        self.visited_states: Set[str] = set()
        self.state_queue: List[Tuple[PageState, int]] = []
        self.states_map: Dict[str, PageState] = {}
        self.transitions: List[StateTransition] = []
        self.max_depth = 3
        self.target_domain = None
        self.logged_in = False
        
    def close(self):
        self.driver.close()
        
    async def capture_state(self, page: Page, state_type: str = "page") -> PageState:
        """Capture the current state of a page"""
        await page.wait_for_load_state('networkidle')
        
        url = page.url
        title = await page.title()
        html = await page.content()
        
        # Enhanced ARIA snapshot for Rocket.Chat
        aria_snapshot = await page.evaluate("""
            () => {
                const getAllAriaInfo = (element, depth = 0) => {
                    const info = {
                        tag: element.tagName.toLowerCase(),
                        role: element.getAttribute('role'),
                        'aria-label': element.getAttribute('aria-label'),
                        'data-qa': element.getAttribute('data-qa'),  // Rocket.Chat uses data-qa
                        'data-qa-id': element.getAttribute('data-qa-id'),
                        id: element.id,
                        className: element.className,
                        textContent: element.textContent?.trim().substring(0, 100),
                        children: []
                    };
                    
                    // Clean up null values
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
                
                // Also capture Rocket.Chat specific elements
                const rcElements = {
                    channels: document.querySelectorAll('[data-qa="sidebar-item"]').length,
                    messages: document.querySelectorAll('[data-qa="message"]').length,
                    users: document.querySelectorAll('[data-qa="user-item"]').length,
                    hasMainContent: !!document.querySelector('.main-content'),
                    hasSidebar: !!document.querySelector('.sidebar')
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
    
    async def wait_for_rocket_chat_load(self, page: Page, timeout: int = 30000):
        """Wait for Rocket.Chat to fully load"""
        logger.info("Waiting for Rocket.Chat to load...")
        
        try:
            # Wait for main Rocket.Chat elements
            await page.wait_for_selector('.main-content, .rc-old', 
                                        state='visible', 
                                        timeout=timeout)
            logger.info("Main content detected")
            
            # Additional wait for dynamic content
            await page.wait_for_timeout(2000)
            
            # Check if we're on the login page or main app
            is_login_page = await page.evaluate("""
                () => {
                    return !!(document.querySelector('[data-qa="login-button"]') || 
                             document.querySelector('input[name="username"]') ||
                             document.querySelector('.login-form'));
                }
            """)
            
            if is_login_page:
                logger.info("Still on login page")
                return False
            
            # Check for main app elements
            has_app_elements = await page.evaluate("""
                () => {
                    return !!(document.querySelector('.sidebar') || 
                             document.querySelector('[data-qa="sidebar"]') ||
                             document.querySelector('.main-content') ||
                             document.querySelector('.rc-old'));
                }
            """)
            
            if has_app_elements:
                logger.info("Rocket.Chat app loaded successfully")
                return True
                
        except PlaywrightTimeoutError:
            logger.warning("Timeout waiting for Rocket.Chat to load")
            
        return False
    
    async def perform_rocket_chat_login(self, page: Page, login_url: str) -> bool:
        """Perform Rocket.Chat specific login"""
        logger.info(f"Attempting Rocket.Chat login at {login_url}")
        
        await page.goto(login_url, wait_until='domcontentloaded')
        await page.wait_for_timeout(3000)  # Wait for any redirects
        
        # Take screenshot of login page
        await page.screenshot(path="login_page.png")
        logger.info("Login page screenshot saved")
        
        # Try multiple selector strategies
        username_selectors = [
            'input[name="username"]',
            'input[name="emailOrUsername"]',
            'input[type="text"][autocomplete="username"]',
            'input[placeholder*="username" i]',
            'input[placeholder*="email" i]',
            '#username',
            '[data-qa="login-username"]',
            '.login-form input[type="text"]'
        ]
        
        password_selectors = [
            'input[name="password"]',
            'input[type="password"]',
            'input[placeholder*="password" i]',
            '#password',
            '[data-qa="login-password"]',
            '.login-form input[type="password"]'
        ]
        
        # Find and fill username
        username_filled = False
        for selector in username_selectors:
            try:
                element = await page.query_selector(selector)
                if element and await element.is_visible():
                    await element.click()
                    await element.fill('')  # Clear first
                    await element.type(LOGIN_USERNAME, delay=100)
                    username_filled = True
                    logger.info(f"Filled username with selector: {selector}")
                    break
            except Exception as e:
                continue
        
        # Find and fill password
        password_filled = False
        for selector in password_selectors:
            try:
                element = await page.query_selector(selector)
                if element and await element.is_visible():
                    await element.click()
                    await element.fill('')  # Clear first
                    await element.type(LOGIN_PASSWORD, delay=100)
                    password_filled = True
                    logger.info(f"Filled password with selector: {selector}")
                    break
            except Exception as e:
                continue
        
        if not username_filled or not password_filled:
            logger.error(f"Failed to fill login form - username: {username_filled}, password: {password_filled}")
            
            # Debug: log all input fields found
            inputs = await page.evaluate("""
                () => {
                    const inputs = Array.from(document.querySelectorAll('input'));
                    return inputs.map(input => ({
                        type: input.type,
                        name: input.name,
                        id: input.id,
                        placeholder: input.placeholder,
                        visible: input.offsetWidth > 0 && input.offsetHeight > 0
                    }));
                }
            """)
            logger.info(f"Found input fields: {json.dumps(inputs, indent=2)}")
            return False
        
        # Submit login
        submit_selectors = [
            'button[type="submit"]',
            '[data-qa="login-button"]',
            'button.login',
            'button:has-text("Login")',
            'button:has-text("Sign in")',
            '.login-form button',
            'input[type="submit"]'
        ]
        
        submitted = False
        for selector in submit_selectors:
            try:
                element = await page.query_selector(selector)
                if element and await element.is_visible():
                    await element.click()
                    submitted = True
                    logger.info(f"Clicked submit with selector: {selector}")
                    break
            except:
                continue
        
        if not submitted:
            # Try pressing Enter in password field
            logger.info("Trying to submit by pressing Enter")
            await page.keyboard.press('Enter')
        
        # Wait for navigation or error
        try:
            await page.wait_for_navigation(timeout=10000)
            logger.info(f"Navigation completed, new URL: {page.url}")
        except:
            logger.info("No navigation detected, checking for errors or dynamic login")
        
        # Wait for app to load
        await page.wait_for_timeout(5000)
        
        # Check if login succeeded
        login_success = await self.wait_for_rocket_chat_load(page)
        
        if login_success:
            self.logged_in = True
            await page.screenshot(path="after_login_success.png")
            logger.info("Login successful!")
        else:
            # Check for error messages
            error_message = await page.evaluate("""
                () => {
                    const errorSelectors = [
                        '.error-message',
                        '[data-qa="login-error"]',
                        '.alert-danger',
                        '.toast-error'
                    ];
                    for (const selector of errorSelectors) {
                        const element = document.querySelector(selector);
                        if (element) return element.textContent;
                    }
                    return null;
                }
            """)
            
            if error_message:
                logger.error(f"Login error: {error_message}")
            
            await page.screenshot(path="login_failed.png")
            
        return login_success
    
    async def find_rocket_chat_elements(self, page: Page) -> List[Dict]:
        """Find Rocket.Chat specific interactive elements"""
        await page.wait_for_load_state('networkidle')
        
        elements = await page.evaluate("""
            () => {
                const interactiveElements = [];
                const processedElements = new Set();
                
                // Rocket.Chat specific selectors
                const rcSelectors = {
                    channels: '[data-qa="sidebar-item"]',
                    directMessages: '[data-qa="sidebar-item-direct"]',
                    userItems: '[data-qa="user-item"]',
                    menuItems: '[data-qa*="menu-item"]',
                    buttons: '[data-qa*="button"]',
                    links: 'a[href]:not([href="#"])',
                    tabs: '[role="tab"]',
                    settings: '[data-qa="sidebar-settings"]',
                    profile: '[data-qa="sidebar-avatar"]',
                    // Generic interactive elements
                    clickable: 'button, [role="button"], .clickable, [onclick]'
                };
                
                // Process each type of element
                for (const [type, selector] of Object.entries(rcSelectors)) {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach((element) => {
                        if (processedElements.has(element)) return;
                        processedElements.add(element);
                        
                        const rect = element.getBoundingClientRect();
                        const style = window.getComputedStyle(element);
                        
                        if (rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            parseFloat(style.opacity) > 0) {
                            
                            // Create unique selector
                            let uniqueSelector = '';
                            if (element.getAttribute('data-qa')) {
                                uniqueSelector = `[data-qa="${element.getAttribute('data-qa')}"]`;
                            } else if (element.id) {
                                uniqueSelector = `#${element.id}`;
                            } else if (element.className) {
                                const classes = element.className.split(' ').filter(c => c);
                                if (classes.length > 0) {
                                    uniqueSelector = `.${classes[0]}`;
                                }
                            } else {
                                uniqueSelector = element.tagName.toLowerCase();
                            }
                            
                            // Get meaningful text
                            let text = element.textContent?.trim() || '';
                            if (text.length > 50) text = text.substring(0, 50) + '...';
                            
                            // Get href for links
                            const href = element.getAttribute('href');
                            
                            interactiveElements.push({
                                selector: uniqueSelector,
                                text: text,
                                type: type,
                                actionType: href ? 'navigate' : 'click',
                                href: href,
                                dataQa: element.getAttribute('data-qa'),
                                ariaLabel: element.getAttribute('aria-label')
                            });
                        }
                    });
                }
                
                console.log(`Found ${interactiveElements.length} interactive elements`);
                return interactiveElements;
            }
        """)
        
        logger.info(f"Found {len(elements)} Rocket.Chat elements")
        if elements:
            logger.info(f"Sample elements: {elements[:5]}")
        
        return elements
    
    async def crawl_rocket_chat(self, start_url: str, max_depth: int = 3):
        """Crawl Rocket.Chat application"""
        self.max_depth = max_depth
        self.target_domain = urlparse(start_url).netloc
        
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
            
            # Login to Rocket.Chat
            login_success = await self.perform_rocket_chat_login(page, start_url)
            
            if not login_success:
                logger.error("Failed to login to Rocket.Chat")
                await browser.close()
                return
            
            # Capture initial state after login
            initial_state = await self.capture_state(page, state_type="main")
            self.state_queue.append((initial_state, 0))
            self.states_map[initial_state.state_hash] = initial_state
            
            # BFS traversal
            processed_count = 0
            while self.state_queue and processed_count < 20:  # Limit total states
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
                    await self.wait_for_rocket_chat_load(page)
                
                # Find interactive elements
                elements = await self.find_rocket_chat_elements(page)
                
                # Process top elements only
                for i, element in enumerate(elements[:5]):  # Limit elements per page
                    try:
                        logger.info(f"Trying element {i+1}/{min(5, len(elements))}: {element['type']} - {element['text']}")
                        
                        # Save state before interaction
                        before_url = page.url
                        
                        # Perform interaction
                        if element['actionType'] == 'navigate' and element['href']:
                            target_url = urljoin(before_url, element['href'])
                            if urlparse(target_url).netloc == self.target_domain:
                                await page.goto(target_url, wait_until='networkidle')
                        else:
                            # Click element
                            try:
                                await page.click(element['selector'], timeout=5000)
                                await page.wait_for_timeout(2000)  # Wait for any animations
                            except:
                                logger.warning(f"Failed to click {element['selector']}")
                                continue
                        
                        # Capture new state
                        new_state = await self.capture_state(page, state_type=element['type'])
                        
                        # Check if state changed
                        if new_state.state_hash != current_state.state_hash:
                            # Record transition
                            transition = StateTransition(
                                from_state_hash=current_state.state_hash,
                                to_state_hash=new_state.state_hash,
                                action_type=element['actionType'],
                                element_selector=element['selector'],
                                element_text=element['text'],
                                element_id=element.get('dataQa')
                            )
                            self.transitions.append(transition)
                            
                            # Add new state to queue
                            if new_state.state_hash not in self.visited_states:
                                self.state_queue.append((new_state, depth + 1))
                                self.states_map[new_state.state_hash] = new_state
                            
                            logger.info(f"Recorded transition: {element['actionType']} on {element['text']}")
                            
                            # Go back if needed
                            if page.url != current_state.url:
                                await page.goto(current_state.url, wait_until='networkidle')
                                await self.wait_for_rocket_chat_load(page)
                        
                    except Exception as e:
                        logger.error(f"Error processing element: {e}")
                        continue
            
            # Take final screenshot
            await page.screenshot(path="final_state.png")
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
                            state_type: $state_type
                        })
                    """, 
                    hash=state_obj.state_hash,
                    url=state_obj.url,
                    title=state_obj.title,
                    timestamp=state_obj.timestamp.isoformat(),
                    domain=self.target_domain,
                    state_type=state_obj.state_type
                    )
                    
                    # Store content separately
                    session.run("""
                        MATCH (s:State {hash: $hash})
                        CREATE (s)-[:HAS_CONTENT]->(c:Content {
                            html: $html,
                            aria_snapshot: $aria,
                            screenshot: $screenshot
                        })
                    """,
                    hash=state_obj.state_hash,
                    html=state_obj.html[:5000],  # Limit size
                    aria=state_obj.aria_snapshot,
                    screenshot=state_obj.screenshot_base64[:1000]  # Store reference only
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
    crawler = RocketChatCrawler(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    
    try:
        logger.info(f"Starting Rocket.Chat crawl of {TARGET_URL}")
        await crawler.crawl_rocket_chat(TARGET_URL, max_depth=3)
        
        # Save to Neo4j
        crawler.save_to_neo4j()
        
        logger.info("Crawl completed successfully!")
        logger.info(f"Visit http://localhost:7474 to view the graph")
        logger.info("Sample queries:")
        logger.info("  MATCH (s:State) RETURN s")
        logger.info("  MATCH (s1:State)-[t:TRANSITION]->(s2:State) RETURN s1, t, s2")
        logger.info("  MATCH (s:State {state_type: 'channel'}) RETURN s")
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())