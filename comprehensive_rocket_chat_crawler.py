import asyncio
import json
import base64
import requests
from datetime import datetime
from urllib.parse import urlparse
from typing import Dict, List, Set, Tuple
from dataclasses import dataclass, field
import hashlib
import logging

from neo4j import GraphDatabase
from playwright.async_api import async_playwright, Page

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
        content = f"{self.url}{self.title}{self.state_type}"
        self.state_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

@dataclass
class StateTransition:
    from_state_hash: str
    to_state_hash: str
    action_type: str
    element_text: str

class ComprehensiveRocketChatCrawler:
    def __init__(self):
        self.driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        self.visited_states: Set[str] = set()
        self.states: List[PageState] = []
        self.transitions: List[StateTransition] = []
        self.auth_token = None
        self.user_id = None
        
    def close(self):
        self.driver.close()
    
    def api_login(self) -> bool:
        """Login via API to get all channels"""
        login_url = f"{TARGET_URL}/api/v1/login"
        
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
        except Exception as e:
            logger.error(f"API login error: {e}")
        return False
    
    def get_all_channels(self) -> List[Dict]:
        """Get all channels via API"""
        if not self.auth_token:
            return []
            
        all_channels = []
        
        # Get public channels
        try:
            response = requests.get(
                f"{TARGET_URL}/api/v1/channels.list",
                headers={
                    "X-Auth-Token": self.auth_token,
                    "X-User-Id": self.user_id
                }
            )
            if response.status_code == 200:
                channels = response.json().get('channels', [])
                for ch in channels:
                    all_channels.append({
                        'name': ch['name'],
                        'type': 'channel',
                        'url': f"{TARGET_URL}/channel/{ch['name']}"
                    })
        except:
            pass
        
        # Get direct messages
        try:
            response = requests.get(
                f"{TARGET_URL}/api/v1/im.list",
                headers={
                    "X-Auth-Token": self.auth_token,
                    "X-User-Id": self.user_id
                }
            )
            if response.status_code == 200:
                ims = response.json().get('ims', [])
                for im in ims:
                    username = im.get('usernames', ['unknown'])[0]
                    if username != LOGIN_USERNAME:
                        all_channels.append({
                            'name': username,
                            'type': 'dm',
                            'url': f"{TARGET_URL}/direct/{im['_id']}"
                        })
        except:
            pass
        
        # Get groups
        try:
            response = requests.get(
                f"{TARGET_URL}/api/v1/groups.list",
                headers={
                    "X-Auth-Token": self.auth_token,
                    "X-User-Id": self.user_id
                }
            )
            if response.status_code == 200:
                groups = response.json().get('groups', [])
                for gr in groups:
                    all_channels.append({
                        'name': gr['name'],
                        'type': 'group',
                        'url': f"{TARGET_URL}/group/{gr['name']}"
                    })
        except:
            pass
        
        logger.info(f"Found {len(all_channels)} total channels/DMs/groups via API")
        return all_channels
    
    async def capture_state(self, page: Page, state_type: str, name: str = "") -> PageState:
        """Capture page state with metadata"""
        await page.wait_for_load_state('networkidle', timeout=10000)
        
        url = page.url
        title = await page.title()
        
        # Capture metadata
        metadata = await page.evaluate("""
            () => {
                const getTextContent = (selector) => {
                    const elem = document.querySelector(selector);
                    return elem ? elem.textContent.trim() : '';
                };
                
                return {
                    currentRoom: getTextContent('[data-qa="room-title"]') || getTextContent('.rc-room-header__name'),
                    roomTopic: getTextContent('.rc-room-header__topic'),
                    messageCount: document.querySelectorAll('[data-qa="message"], .message').length,
                    memberCount: document.querySelectorAll('.members-list__item').length,
                    hasSidebar: !!document.querySelector('.sidebar'),
                    hasMainContent: !!document.querySelector('.main-content'),
                    isLoggedIn: !!document.querySelector('.sidebar'),
                    activeUsers: Array.from(document.querySelectorAll('.sidebar-item__user-status--online')).length,
                    totalSidebarItems: document.querySelectorAll('.sidebar-item').length
                };
            }
        """)
        
        metadata['name'] = name
        
        return PageState(
            url=url,
            title=title,
            state_type=state_type,
            timestamp=datetime.now(),
            metadata=metadata
        )
    
    async def login_browser(self, page: Page) -> bool:
        """Login via browser"""
        logger.info("Browser login process...")
        await page.goto(TARGET_URL, wait_until='networkidle')
        await page.wait_for_timeout(2000)
        
        # Check if already logged in
        is_logged_in = await page.evaluate("() => !!document.querySelector('.sidebar')")
        if is_logged_in:
            return True
        
        # Fill login form
        await page.fill('input[name="emailOrUsername"]', LOGIN_USERNAME)
        await page.fill('input[type="password"]', LOGIN_PASSWORD)
        await page.click('button.login')
        
        # Wait for login
        await page.wait_for_timeout(8000)
        
        # Verify
        is_logged_in = await page.evaluate("() => !!document.querySelector('.sidebar')")
        logger.info(f"Browser login status: {is_logged_in}")
        return is_logged_in
    
    async def explore_ui_elements(self, page: Page, current_state: PageState) -> List[Tuple[str, str, str]]:
        """Explore UI elements like buttons, menus, etc."""
        elements = []
        
        # Sidebar buttons
        sidebar_buttons = await page.evaluate("""
            () => {
                const buttons = [];
                // Home button
                const homeBtn = document.querySelector('[data-qa="sidebar-home"]');
                if (homeBtn) buttons.push({url: '/home', text: 'Home', type: 'navigation'});
                
                // Search
                const searchBtn = document.querySelector('[data-qa="sidebar-search"]');
                if (searchBtn) buttons.push({url: '/search', text: 'Search', type: 'feature'});
                
                // Directory
                const dirBtn = document.querySelector('[data-qa="sidebar-directory"]');
                if (dirBtn) buttons.push({url: '/directory', text: 'Directory', type: 'feature'});
                
                // Create channel
                const createBtn = document.querySelector('[data-qa="sidebar-create"]');
                if (createBtn) buttons.push({url: '/create-channel', text: 'Create Channel', type: 'feature'});
                
                // Settings/Profile
                const avatar = document.querySelector('[data-qa="sidebar-avatar"]');
                if (avatar) buttons.push({url: '/account', text: 'My Account', type: 'settings'});
                
                return buttons;
            }
        """)
        
        for btn in sidebar_buttons:
            elements.append((f"{TARGET_URL}{btn['url']}", btn['text'], btn['type']))
        
        # Admin panel if available
        admin_link = await page.evaluate("""
            () => {
                const adminLink = document.querySelector('a[href="/admin"]');
                return adminLink ? '/admin' : null;
            }
        """)
        if admin_link:
            elements.append((f"{TARGET_URL}{admin_link}", "Admin Panel", "admin"))
        
        return elements
    
    async def comprehensive_crawl(self):
        """Comprehensive crawling with API data"""
        # First get API data
        if not self.api_login():
            logger.warning("API login failed, continuing with browser only")
        
        all_channels = self.get_all_channels()
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # Browser login
            if not await self.login_browser(page):
                logger.error("Browser login failed")
                await browser.close()
                return
            
            # 1. Capture home state
            home_state = await self.capture_state(page, "home", "Home")
            self.states.append(home_state)
            self.visited_states.add(home_state.state_hash)
            logger.info(f"Captured home state")
            
            # 2. Explore UI elements from home
            ui_elements = await self.explore_ui_elements(page, home_state)
            logger.info(f"Found {len(ui_elements)} UI elements")
            
            for url, text, elem_type in ui_elements:
                try:
                    logger.info(f"Visiting UI element: {text} ({elem_type})")
                    await page.goto(url, wait_until='networkidle', timeout=15000)
                    await page.wait_for_timeout(1000)
                    
                    ui_state = await self.capture_state(page, elem_type, text)
                    if ui_state.state_hash not in self.visited_states:
                        self.states.append(ui_state)
                        self.visited_states.add(ui_state.state_hash)
                        
                        self.transitions.append(StateTransition(
                            from_state_hash=home_state.state_hash,
                            to_state_hash=ui_state.state_hash,
                            action_type="navigate",
                            element_text=f"UI: {text}"
                        ))
                except Exception as e:
                    logger.warning(f"Failed to visit UI element {text}: {e}")
            
            # 3. Visit all channels/DMs from API
            for i, channel in enumerate(all_channels):
                try:
                    logger.info(f"Visiting {i+1}/{len(all_channels)}: {channel['type']} - {channel['name']}")
                    await page.goto(channel['url'], wait_until='networkidle', timeout=15000)
                    await page.wait_for_timeout(1000)
                    
                    channel_state = await self.capture_state(page, channel['type'], channel['name'])
                    
                    if channel_state.state_hash not in self.visited_states:
                        self.states.append(channel_state)
                        self.visited_states.add(channel_state.state_hash)
                        
                        # Transition from home
                        self.transitions.append(StateTransition(
                            from_state_hash=home_state.state_hash,
                            to_state_hash=channel_state.state_hash,
                            action_type="navigate",
                            element_text=f"{channel['type'].upper()}: {channel['name']}"
                        ))
                        
                        # Explore channel-specific features
                        if channel['type'] == 'channel':
                            # Try channel info
                            try:
                                info_url = f"{channel['url']}/info"
                                await page.goto(info_url, wait_until='networkidle', timeout=10000)
                                info_state = await self.capture_state(page, "channel-info", f"{channel['name']} Info")
                                
                                if info_state.state_hash not in self.visited_states:
                                    self.states.append(info_state)
                                    self.visited_states.add(info_state.state_hash)
                                    
                                    self.transitions.append(StateTransition(
                                        from_state_hash=channel_state.state_hash,
                                        to_state_hash=info_state.state_hash,
                                        action_type="navigate",
                                        element_text="Channel Info"
                                    ))
                            except:
                                pass
                                
                except Exception as e:
                    logger.warning(f"Failed to visit {channel['name']}: {e}")
            
            # 4. Account/Profile pages
            profile_urls = [
                (f"{TARGET_URL}/account/preferences", "Preferences", "preferences"),
                (f"{TARGET_URL}/account/profile", "Profile", "profile"),
                (f"{TARGET_URL}/account/security", "Security", "security"),
                (f"{TARGET_URL}/account/integrations", "Integrations", "integrations")
            ]
            
            for url, name, page_type in profile_urls:
                try:
                    logger.info(f"Visiting account page: {name}")
                    await page.goto(url, wait_until='networkidle', timeout=15000)
                    await page.wait_for_timeout(1000)
                    
                    account_state = await self.capture_state(page, page_type, name)
                    if account_state.state_hash not in self.visited_states:
                        self.states.append(account_state)
                        self.visited_states.add(account_state.state_hash)
                        
                        self.transitions.append(StateTransition(
                            from_state_hash=home_state.state_hash,
                            to_state_hash=account_state.state_hash,
                            action_type="navigate",
                            element_text=f"Account: {name}"
                        ))
                except:
                    pass
            
            logger.info(f"Comprehensive crawl complete: {len(self.states)} states, {len(self.transitions)} transitions")
            await browser.close()
    
    def save_to_neo4j(self):
        """Save comprehensive data to Neo4j"""
        with self.driver.session() as session:
            # Clear
            session.run("MATCH (n) DETACH DELETE n")
            
            # Create states with full metadata
            for state in self.states:
                session.run("""
                    CREATE (s:State {
                        hash: $hash,
                        url: $url,
                        title: $title,
                        state_type: $type,
                        name: $name,
                        timestamp: $ts,
                        is_logged_in: $logged_in,
                        current_room: $room,
                        room_topic: $topic,
                        message_count: $msg_count,
                        member_count: $member_count,
                        active_users: $active,
                        total_sidebar_items: $sidebar_items
                    })
                """,
                hash=state.state_hash,
                url=state.url,
                title=state.title,
                type=state.state_type,
                name=state.metadata.get('name', ''),
                ts=state.timestamp.isoformat(),
                logged_in=state.metadata.get('isLoggedIn', False),
                room=state.metadata.get('currentRoom', ''),
                topic=state.metadata.get('roomTopic', ''),
                msg_count=state.metadata.get('messageCount', 0),
                member_count=state.metadata.get('memberCount', 0),
                active=state.metadata.get('activeUsers', 0),
                sidebar_items=state.metadata.get('totalSidebarItems', 0)
                )
            
            # Create transitions
            for trans in self.transitions:
                session.run("""
                    MATCH (from:State {hash: $from_hash}), (to:State {hash: $to_hash})
                    CREATE (from)-[:TRANSITION {
                        action: $action,
                        text: $text
                    }]->(to)
                """,
                from_hash=trans.from_state_hash,
                to_hash=trans.to_state_hash,
                action=trans.action_type,
                text=trans.element_text
                )
            
            # Summary
            logger.info(f"\nSaved to Neo4j:")
            
            result = session.run("""
                MATCH (s:State)
                WITH s.state_type as type, count(s) as count
                RETURN type, count
                ORDER BY count DESC
            """)
            
            for record in result:
                logger.info(f"  {record['type']}: {record['count']}")
            
            logger.info(f"\nTotal: {len(self.states)} states and {len(self.transitions)} transitions")

async def main():
    crawler = ComprehensiveRocketChatCrawler()
    
    try:
        logger.info("Starting comprehensive Rocket.Chat crawl...")
        await crawler.comprehensive_crawl()
        crawler.save_to_neo4j()
        
        logger.info("\n✅ Complete! Check Neo4j at http://localhost:7474")
        logger.info("\nUseful queries:")
        logger.info("  MATCH (s:State) RETURN s.state_type, count(*)")
        logger.info("  MATCH (s:State {state_type: 'channel'}) RETURN s")
        logger.info("  MATCH path = (home:State {state_type: 'home'})-[:TRANSITION*..3]->(s) RETURN path")
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())