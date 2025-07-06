import asyncio
import json
import base64
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

class FastRocketChatCrawler:
    def __init__(self):
        self.driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        self.visited_states: Set[str] = set()
        self.states: List[PageState] = []
        self.transitions: List[StateTransition] = []
        
    def close(self):
        self.driver.close()
    
    async def quick_capture(self, page: Page, state_type: str) -> PageState:
        """Quick state capture without heavy operations"""
        await page.wait_for_load_state('domcontentloaded')
        
        url = page.url
        title = await page.title()
        
        # Quick metadata extraction
        metadata = await page.evaluate("""
            () => ({
                hasChannels: !!document.querySelector('[data-qa*="sidebar-item"]'),
                hasDMs: !!document.querySelector('[data-qa*="direct"]'),
                currentRoom: document.querySelector('[data-qa="room-title"]')?.textContent || '',
                isLoggedIn: !!document.querySelector('.sidebar')
            })
        """)
        
        return PageState(
            url=url,
            title=title,
            state_type=state_type,
            timestamp=datetime.now(),
            metadata=metadata
        )
    
    async def fast_login(self, page: Page) -> bool:
        """Fast login process"""
        logger.info("Fast login process starting...")
        await page.goto(TARGET_URL, wait_until='domcontentloaded')
        await page.wait_for_timeout(2000)
        
        # Quick login
        await page.fill('input[name="emailOrUsername"]', LOGIN_USERNAME)
        await page.fill('input[type="password"]', LOGIN_PASSWORD)
        await page.click('button.login')
        
        # Wait for login
        await page.wait_for_timeout(5000)
        
        # Verify
        is_logged_in = await page.evaluate("() => !!document.querySelector('.sidebar')")
        logger.info(f"Login status: {is_logged_in}")
        return is_logged_in
    
    async def get_all_links(self, page: Page) -> List[Dict]:
        """Get all navigation links at once"""
        return await page.evaluate("""
            () => {
                const links = [];
                
                // Get all channels
                document.querySelectorAll('a[href*="/channel/"]').forEach(link => {
                    links.push({
                        url: link.href,
                        text: 'Channel: ' + (link.textContent?.trim() || 'Unknown'),
                        type: 'channel'
                    });
                });
                
                // Get all DMs
                document.querySelectorAll('a[href*="/direct/"]').forEach(link => {
                    links.push({
                        url: link.href,
                        text: 'DM: ' + (link.textContent?.trim() || 'Unknown'),
                        type: 'dm'
                    });
                });
                
                // Add home
                links.push({
                    url: location.origin + '/home',
                    text: 'Home',
                    type: 'home'
                });
                
                return links;
            }
        """)
    
    async def crawl_fast(self):
        """Fast crawling of all states"""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # Login
            if not await self.fast_login(page):
                logger.error("Login failed")
                await browser.close()
                return
            
            # Capture home state
            home_state = await self.quick_capture(page, "home")
            self.states.append(home_state)
            self.visited_states.add(home_state.state_hash)
            
            # Get all links
            all_links = await self.get_all_links(page)
            logger.info(f"Found {len(all_links)} total links")
            
            # Visit each link
            for i, link in enumerate(all_links):
                if link['url'] in [s.url for s in self.states]:
                    continue
                    
                logger.info(f"Visiting {i+1}/{len(all_links)}: {link['text']}")
                
                try:
                    await page.goto(link['url'], wait_until='domcontentloaded', timeout=10000)
                    await page.wait_for_timeout(1000)
                    
                    # Capture state
                    new_state = await self.quick_capture(page, link['type'])
                    
                    if new_state.state_hash not in self.visited_states:
                        self.states.append(new_state)
                        self.visited_states.add(new_state.state_hash)
                        
                        # Record transition from home
                        self.transitions.append(StateTransition(
                            from_state_hash=home_state.state_hash,
                            to_state_hash=new_state.state_hash,
                            action_type="navigate",
                            element_text=link['text']
                        ))
                        
                except Exception as e:
                    logger.warning(f"Failed to visit {link['url']}: {e}")
            
            # Quick second-level exploration from each channel/dm
            current_states = list(self.states)
            for state in current_states:
                if state.state_type in ['channel', 'dm'] and state.url != home_state.url:
                    logger.info(f"Exploring from {state.state_type}: {state.url}")
                    
                    try:
                        await page.goto(state.url, wait_until='domcontentloaded', timeout=10000)
                        await page.wait_for_timeout(1000)
                        
                        # Get sub-links
                        sub_links = await self.get_all_links(page)
                        
                        for link in sub_links[:5]:  # Limit sub-exploration
                            if link['url'] not in [s.url for s in self.states]:
                                try:
                                    await page.goto(link['url'], wait_until='domcontentloaded', timeout=10000)
                                    await page.wait_for_timeout(500)
                                    
                                    sub_state = await self.quick_capture(page, link['type'])
                                    
                                    if sub_state.state_hash not in self.visited_states:
                                        self.states.append(sub_state)
                                        self.visited_states.add(sub_state.state_hash)
                                        
                                        self.transitions.append(StateTransition(
                                            from_state_hash=state.state_hash,
                                            to_state_hash=sub_state.state_hash,
                                            action_type="navigate",
                                            element_text=link['text']
                                        ))
                                        
                                except:
                                    pass
                                    
                    except:
                        pass
            
            logger.info(f"Crawl complete: {len(self.states)} states, {len(self.transitions)} transitions")
            await browser.close()
    
    def save_to_neo4j(self):
        """Save to Neo4j"""
        with self.driver.session() as session:
            # Clear
            session.run("MATCH (n) DETACH DELETE n")
            
            # Create states
            for state in self.states:
                session.run("""
                    CREATE (s:State {
                        hash: $hash,
                        url: $url,
                        title: $title,
                        state_type: $type,
                        timestamp: $ts,
                        is_logged_in: $logged_in,
                        current_room: $room
                    })
                """,
                hash=state.state_hash,
                url=state.url,
                title=state.title,
                type=state.state_type,
                ts=state.timestamp.isoformat(),
                logged_in=state.metadata.get('isLoggedIn', False),
                room=state.metadata.get('currentRoom', '')
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
            
            logger.info(f"Saved {len(self.states)} states and {len(self.transitions)} transitions to Neo4j")

async def main():
    crawler = FastRocketChatCrawler()
    
    try:
        logger.info("Starting fast Rocket.Chat crawl...")
        await crawler.crawl_fast()
        crawler.save_to_neo4j()
        logger.info("Complete! Check Neo4j at http://localhost:7474")
        
    finally:
        crawler.close()

if __name__ == "__main__":
    asyncio.run(main())