import asyncio
import json
import base64
import requests
from datetime import datetime
from urllib.parse import urlparse, urljoin
from typing import Dict, List, Set, Tuple, Optional
from dataclasses import dataclass, field
import hashlib
import logging

from neo4j import GraphDatabase
from playwright.async_api import async_playwright, Page, ElementHandle

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
    url: str
    title: str
    state_type: str
    timestamp: datetime
    metadata: Dict = field(default_factory=dict)
    state_hash: str = field(init=False)
    
    def __post_init__(self):
        # More unique hash including metadata
        content = f"{self.url}{self.title}{self.state_type}{json.dumps(self.metadata, sort_keys=True)}"
        self.state_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

@dataclass
class StateTransition:
    from_state_hash: str
    to_state_hash: str
    action_type: str
    element_selector: str
    element_text: str
    element_id: Optional[str] = None

class FullStateGraphCrawler:
    def __init__(self):
        self.driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        self.visited_states: Set[str] = set()
        self.states: Dict[str, PageState] = {}  # hash -> state
        self.transitions: List[StateTransition] = []
        self.pending_states: List[Tuple[PageState, List[str]]] = []  # (state, path_to_state)
        self.max_states = 200  # Safety limit
        self.auth_token = None
        self.user_id = None
        
    def close(self):
        self.driver.close()
    
    def api_login(self) -> bool:
        """Login via API"""
        try:
            response = requests.post(f"{TARGET_URL}/api/v1/login", json={
                "user": LOGIN_USERNAME,
                "password": LOGIN_PASSWORD
            })
            
            if response.status_code == 200:
                data = response.json()
                self.auth_token = data['data']['authToken']
                self.user_id = data['data']['userId']
                logger.info(f"API login successful")
                return True
        except:
            pass
        return False
    
    def get_all_resources(self) -> Dict[str, List[Dict]]:
        """Get all available resources via API"""
        resources = {
            'channels': [],
            'dms': [],
            'groups': [],
            'teams': []
        }
        
        if not self.auth_token:
            return resources
        
        headers = {
            "X-Auth-Token": self.auth_token,
            "X-User-Id": self.user_id
        }
        
        # Get channels
        try:
            resp = requests.get(f"{TARGET_URL}/api/v1/channels.list", headers=headers)
            if resp.status_code == 200:
                for ch in resp.json().get('channels', []):
                    resources['channels'].append({
                        'name': ch['name'],
                        'id': ch['_id'],
                        'url': f"{TARGET_URL}/channel/{ch['name']}"
                    })
        except:
            pass
        
        # Get DMs
        try:
            resp = requests.get(f"{TARGET_URL}/api/v1/im.list", headers=headers)
            if resp.status_code == 200:
                for im in resp.json().get('ims', []):
                    resources['dms'].append({
                        'name': im.get('usernames', ['unknown'])[0],
                        'id': im['_id'],
                        'url': f"{TARGET_URL}/direct/{im['_id']}"
                    })
        except:
            pass
        
        # Get groups
        try:
            resp = requests.get(f"{TARGET_URL}/api/v1/groups.list", headers=headers)
            if resp.status_code == 200:
                for gr in resp.json().get('groups', []):
                    resources['groups'].append({
                        'name': gr['name'],
                        'id': gr['_id'],
                        'url': f"{TARGET_URL}/group/{gr['name']}"
                    })
        except:
            pass
        
        # Get teams
        try:
            resp = requests.get(f"{TARGET_URL}/api/v1/teams.list", headers=headers)
            if resp.status_code == 200:
                for tm in resp.json().get('teams', []):
                    resources['teams'].append({
                        'name': tm['name'],
                        'id': tm['_id'],
                        'url': f"{TARGET_URL}/team/{tm['name']}"
                    })
        except:
            pass
        
        total = sum(len(v) for v in resources.values())
        logger.info(f"Found {total} total resources via API")
        return resources
    
    async def capture_full_state(self, page: Page, state_type: str, name: str = "") -> PageState:
        """Capture complete page state"""
        await page.wait_for_load_state('networkidle', timeout=10000)
        await page.wait_for_timeout(500)  # Extra wait for dynamic content
        
        url = page.url
        title = await page.title()
        
        # Comprehensive metadata extraction
        metadata = await page.evaluate("""
            () => {
                const getTextContent = (selector) => {
                    const elem = document.querySelector(selector);
                    return elem ? elem.textContent.trim() : '';
                };
                
                const getElements = (selector) => {
                    return Array.from(document.querySelectorAll(selector)).map(e => ({
                        text: e.textContent?.trim(),
                        href: e.href,
                        id: e.id,
                        classes: e.className
                    }));
                };
                
                return {
                    // Room info
                    currentRoom: getTextContent('[data-qa="room-title"]') || getTextContent('.rc-room-header__name'),
                    roomTopic: getTextContent('.rc-room-header__topic'),
                    roomDescription: getTextContent('.rc-room-header__description'),
                    
                    // Content counts
                    messageCount: document.querySelectorAll('[data-qa="message"], .message').length,
                    memberCount: document.querySelectorAll('.members-list__item').length,
                    fileCount: document.querySelectorAll('.attachment-file').length,
                    
                    // Navigation elements
                    tabs: getElements('[role="tab"]'),
                    buttons: getElements('button:not([disabled])').slice(0, 20),
                    links: getElements('a[href]:not([href="#"])').slice(0, 20),
                    
                    // UI state
                    hasSidebar: !!document.querySelector('.sidebar'),
                    hasMainContent: !!document.querySelector('.main-content'),
                    hasModal: !!document.querySelector('.rc-modal'),
                    hasContextMenu: !!document.querySelector('.rc-popover'),
                    
                    // User context
                    isLoggedIn: !!document.querySelector('.sidebar'),
                    currentUser: document.querySelector('[data-qa="sidebar-avatar"]')?.getAttribute('title'),
                    
                    // Page specifics
                    formFields: getElements('input:not([type="hidden"]), select, textarea').slice(0, 10),
                    activeTab: getTextContent('[role="tab"][aria-selected="true"]'),
                    breadcrumbs: getElements('.rc-breadcrumbs__item')
                };
            }
        """)
        
        metadata['name'] = name
        metadata['captured_at'] = datetime.now().isoformat()
        
        return PageState(
            url=url,
            title=title,
            state_type=state_type,
            timestamp=datetime.now(),
            metadata=metadata
        )
    
    async def find_all_interactions(self, page: Page) -> List[Dict]:
        """Find ALL possible interactions on the page"""
        interactions = await page.evaluate("""
            () => {
                const interactions = [];
                const processedElements = new Set();
                
                // Helper to create unique selector
                const getSelector = (elem) => {
                    if (elem.id) return `#${elem.id}`;
                    if (elem.getAttribute('data-qa')) return `[data-qa="${elem.getAttribute('data-qa')}"]`;
                    
                    let selector = elem.tagName.toLowerCase();
                    if (elem.className) {
                        const classes = elem.className.split(' ').filter(c => c && !c.includes(':'));
                        if (classes.length > 0) selector += `.${classes[0]}`;
                    }
                    
                    // Add nth-child if needed
                    const parent = elem.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(e => e.tagName === elem.tagName);
                        const index = siblings.indexOf(elem);
                        if (index > 0) selector += `:nth-of-type(${index + 1})`;
                    }
                    
                    return selector;
                };
                
                // 1. All links
                document.querySelectorAll('a[href]:not([href="#"]):not([href="javascript:void(0)"])').forEach(link => {
                    if (!processedElements.has(link) && link.offsetWidth > 0) {
                        processedElements.add(link);
                        interactions.push({
                            type: 'link',
                            selector: getSelector(link),
                            text: link.textContent?.trim().substring(0, 50) || 'Link',
                            href: link.href,
                            action: 'navigate'
                        });
                    }
                });
                
                // 2. All buttons
                document.querySelectorAll('button:not([disabled]), [role="button"]:not([disabled])').forEach(btn => {
                    if (!processedElements.has(btn) && btn.offsetWidth > 0) {
                        processedElements.add(btn);
                        interactions.push({
                            type: 'button',
                            selector: getSelector(btn),
                            text: btn.textContent?.trim().substring(0, 50) || btn.getAttribute('aria-label') || 'Button',
                            action: 'click'
                        });
                    }
                });
                
                // 3. Tabs
                document.querySelectorAll('[role="tab"]').forEach(tab => {
                    if (!processedElements.has(tab) && tab.offsetWidth > 0) {
                        processedElements.add(tab);
                        interactions.push({
                            type: 'tab',
                            selector: getSelector(tab),
                            text: tab.textContent?.trim() || 'Tab',
                            action: 'click'
                        });
                    }
                });
                
                // 4. Menu items
                document.querySelectorAll('[role="menuitem"], .menu-item, .dropdown-item').forEach(item => {
                    if (!processedElements.has(item) && item.offsetWidth > 0) {
                        processedElements.add(item);
                        interactions.push({
                            type: 'menu',
                            selector: getSelector(item),
                            text: item.textContent?.trim().substring(0, 50) || 'Menu Item',
                            action: 'click'
                        });
                    }
                });
                
                // 5. Clickable divs/spans with handlers
                document.querySelectorAll('[onclick], [data-action], .clickable, [style*="cursor: pointer"]').forEach(elem => {
                    if (!processedElements.has(elem) && elem.offsetWidth > 0 && 
                        !['A', 'BUTTON'].includes(elem.tagName)) {
                        processedElements.add(elem);
                        interactions.push({
                            type: 'clickable',
                            selector: getSelector(elem),
                            text: elem.textContent?.trim().substring(0, 50) || 'Clickable',
                            action: 'click'
                        });
                    }
                });
                
                // 6. Form submits
                document.querySelectorAll('form').forEach(form => {
                    const submit = form.querySelector('[type="submit"], button[type="submit"]');
                    if (submit && !processedElements.has(submit)) {
                        processedElements.add(submit);
                        interactions.push({
                            type: 'form',
                            selector: getSelector(submit),
                            text: submit.textContent?.trim() || submit.value || 'Submit',
                            action: 'submit'
                        });
                    }
                });
                
                // Remove duplicates
                const seen = new Set();
                return interactions.filter(i => {
                    const key = `${i.selector}-${i.action}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            }
        """)
        
        logger.info(f"Found {len(interactions)} possible interactions")
        return interactions
    
    async def login_browser(self, page: Page) -> bool:
        """Browser login"""
        await page.goto(TARGET_URL, wait_until='networkidle')
        await page.wait_for_timeout(2000)
        
        # Check if already logged in
        is_logged_in = await page.evaluate("() => !!document.querySelector('.sidebar')")
        if is_logged_in:
            return True
        
        # Login
        await page.fill('input[name="emailOrUsername"]', LOGIN_USERNAME)
        await page.fill('input[type="password"]', LOGIN_PASSWORD)
        await page.click('button.login')
        await page.wait_for_timeout(8000)
        
        is_logged_in = await page.evaluate("() => !!document.querySelector('.sidebar')")
        logger.info(f"Login status: {is_logged_in}")
        return is_logged_in
    
    async def explore_state(self, page: Page, current_state: PageState, path: List[str]) -> None:
        """Explore all possible transitions from current state"""
        if len(self.states) >= self.max_states:
            logger.warning(f"Reached max states limit ({self.max_states})")
            return
        
        # Get all possible interactions
        interactions = await self.find_all_interactions(page)
        
        for i, interaction in enumerate(interactions):
            if len(self.states) >= self.max_states:
                break
                
            try:
                logger.info(f"  [{i+1}/{len(interactions)}] Trying {interaction['type']}: {interaction['text'][:30]}")
                
                before_url = page.url
                
                # Perform interaction
                if interaction['action'] == 'navigate' and interaction.get('href'):
                    # Only follow internal links
                    if urlparse(interaction['href']).netloc == urlparse(TARGET_URL).netloc:
                        await page.goto(interaction['href'], wait_until='networkidle', timeout=15000)
                        await page.wait_for_timeout(1000)
                    else:
                        continue
                        
                elif interaction['action'] == 'click':
                    try:
                        # Try to click
                        await page.click(interaction['selector'], timeout=5000)
                        await page.wait_for_timeout(2000)
                        
                        # Check for navigation or modal
                        await page.wait_for_load_state('networkidle', timeout=5000)
                    except:
                        logger.debug(f"    Failed to click {interaction['selector']}")
                        continue
                        
                elif interaction['action'] == 'submit':
                    # Don't submit forms for now
                    continue
                
                # Check if state changed
                after_url = page.url
                new_state = await self.capture_full_state(
                    page, 
                    interaction['type'], 
                    interaction['text']
                )
                
                # Check if this is a new state
                if new_state.state_hash not in self.visited_states:
                    # New state discovered!
                    self.visited_states.add(new_state.state_hash)
                    self.states[new_state.state_hash] = new_state
                    
                    # Record transition
                    self.transitions.append(StateTransition(
                        from_state_hash=current_state.state_hash,
                        to_state_hash=new_state.state_hash,
                        action_type=interaction['action'],
                        element_selector=interaction['selector'],
                        element_text=interaction['text'][:50],
                        element_id=interaction.get('id')
                    ))
                    
                    # Add to pending for further exploration
                    new_path = path + [interaction['text']]
                    self.pending_states.append((new_state, new_path))
                    
                    logger.info(f"    ✓ New state discovered! Total: {len(self.states)}")
                else:
                    # Existing state, but record transition if new
                    existing_transition = any(
                        t.from_state_hash == current_state.state_hash and 
                        t.to_state_hash == new_state.state_hash
                        for t in self.transitions
                    )
                    
                    if not existing_transition:
                        self.transitions.append(StateTransition(
                            from_state_hash=current_state.state_hash,
                            to_state_hash=new_state.state_hash,
                            action_type=interaction['action'],
                            element_selector=interaction['selector'],
                            element_text=interaction['text'][:50]
                        ))
                        logger.info(f"    → New transition to existing state")
                
                # Navigate back if URL changed
                if after_url != before_url:
                    try:
                        await page.goto(before_url, wait_until='networkidle', timeout=15000)
                        await page.wait_for_timeout(1000)
                    except:
                        logger.warning(f"    Failed to navigate back to {before_url}")
                        break
                        
            except Exception as e:
                logger.error(f"    Error with interaction: {e}")
                continue
    
    async def crawl_exhaustive(self):
        """Exhaustive crawling - explore ALL states"""
        # Get API resources
        self.api_login()
        resources = self.get_all_resources()
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # Login
            if not await self.login_browser(page):
                logger.error("Login failed")
                await browser.close()
                return
            
            # Start from home
            home_state = await self.capture_full_state(page, "home", "Home")
            self.visited_states.add(home_state.state_hash)
            self.states[home_state.state_hash] = home_state
            self.pending_states.append((home_state, ["Home"]))
            
            # Add all known resources to pending
            for resource_type, items in resources.items():
                for item in items:
                    try:
                        await page.goto(item['url'], wait_until='networkidle', timeout=15000)
                        state = await self.capture_full_state(page, resource_type.rstrip('s'), item['name'])
                        
                        if state.state_hash not in self.visited_states:
                            self.visited_states.add(state.state_hash)
                            self.states[state.state_hash] = state
                            self.pending_states.append((state, ["Home", item['name']]))
                            
                            # Transition from home
                            self.transitions.append(StateTransition(
                                from_state_hash=home_state.state_hash,
                                to_state_hash=state.state_hash,
                                action_type="navigate",
                                element_selector="api",
                                element_text=f"{resource_type}: {item['name']}"
                            ))
                    except:
                        pass
            
            logger.info(f"Initial states: {len(self.states)}, starting exhaustive exploration...")
            
            # Process all pending states
            processed = 0
            while self.pending_states and len(self.states) < self.max_states:
                current_state, path = self.pending_states.pop(0)
                processed += 1
                
                logger.info(f"\n[{processed}] Exploring: {' > '.join(path[-3:])}")
                logger.info(f"  States: {len(self.states)}, Pending: {len(self.pending_states)}")
                
                # Navigate to state
                try:
                    if page.url != current_state.url:
                        await page.goto(current_state.url, wait_until='networkidle', timeout=15000)
                        await page.wait_for_timeout(1000)
                    
                    # Explore all interactions from this state
                    await self.explore_state(page, current_state, path)
                    
                except Exception as e:
                    logger.error(f"  Failed to explore state: {e}")
                    continue
            
            logger.info(f"\nExhaustive crawl complete!")
            logger.info(f"Total states discovered: {len(self.states)}")
            logger.info(f"Total transitions: {len(self.transitions)}")
            
            await browser.close()
    
    def save_to_neo4j(self):
        """Save complete graph to Neo4j"""
        with self.driver.session() as session:
            # Clear existing
            session.run("MATCH (n) DETACH DELETE n")
            
            # Create states
            for state in self.states.values():
                session.run("""
                    CREATE (s:State {
                        hash: $hash,
                        url: $url,
                        title: $title,
                        state_type: $type,
                        name: $name,
                        timestamp: $ts,
                        current_room: $room,
                        message_count: $messages,
                        has_modal: $modal,
                        active_tab: $tab,
                        form_fields: $forms
                    })
                """,
                hash=state.state_hash,
                url=state.url,
                title=state.title,
                type=state.state_type,
                name=state.metadata.get('name', ''),
                ts=state.timestamp.isoformat(),
                room=state.metadata.get('currentRoom', ''),
                messages=state.metadata.get('messageCount', 0),
                modal=state.metadata.get('hasModal', False),
                tab=state.metadata.get('activeTab', ''),
                forms=len(state.metadata.get('formFields', []))
                )
            
            # Create transitions
            for trans in self.transitions:
                session.run("""
                    MATCH (from:State {hash: $from_hash}), (to:State {hash: $to_hash})
                    CREATE (from)-[:TRANSITION {
                        action: $action,
                        selector: $selector,
                        text: $text
                    }]->(to)
                """,
                from_hash=trans.from_state_hash,
                to_hash=trans.to_state_hash,
                action=trans.action_type,
                selector=trans.element_selector,
                text=trans.element_text
                )
            
            # Analysis
            logger.info("\n=== Graph Analysis ===")
            
            # State types
            result = session.run("""
                MATCH (s:State)
                RETURN s.state_type as type, count(*) as count
                ORDER BY count DESC
            """)
            logger.info("\nState types:")
            for record in result:
                logger.info(f"  {record['type']}: {record['count']}")
            
            # Most connected states
            result = session.run("""
                MATCH (s:State)-[t:TRANSITION]-()
                WITH s, count(t) as connections
                RETURN s.name as name, s.url as url, connections
                ORDER BY connections DESC
                LIMIT 10
            """)
            logger.info("\nMost connected states:")
            for record in result:
                logger.info(f"  {record['name']} ({record['connections']} connections)")
            
            logger.info(f"\nTotal: {len(self.states)} states, {len(self.transitions)} transitions")

async def main():
    crawler = FullStateGraphCrawler()
    
    try:
        logger.info("Starting exhaustive state graph crawl...")
        logger.info("This will explore ALL possible states and transitions.")
        logger.info(f"Safety limit: {crawler.max_states} states\n")
        
        await crawler.crawl_exhaustive()
        crawler.save_to_neo4j()
        
        logger.info("\n✅ Complete! Check Neo4j at http://localhost:7474")
        logger.info("\nUseful queries:")
        logger.info("  // View full graph")
        logger.info("  MATCH (s:State)-[t:TRANSITION]->(s2) RETURN s, t, s2")
        logger.info("  // Find paths between states")
        logger.info("  MATCH path = (s1:State {name:'Home'})-[:TRANSITION*..5]->(s2:State) RETURN path LIMIT 20")
        logger.info("  // Find cycles")
        logger.info("  MATCH (s:State)-[:TRANSITION*2..5]->(s) RETURN DISTINCT s")
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())