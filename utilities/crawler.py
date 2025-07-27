import asyncio
import argparse
import hashlib
import json
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple, Set
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

from playwright.async_api import async_playwright, Page, Browser, BrowserContext, TimeoutError as PlaywrightTimeoutError
from neo4j import AsyncGraphDatabase

import logging
logger = logging.getLogger(__name__)

# Constants
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "password"

TARGET_URL = "http://the-agent-company.com:3000/"
LOGIN_USER = "theagentcompany"
LOGIN_PASS = "theagentcompany"
MAX_STATES = 10000
MAX_DEPTH = 20
PARALLEL_TASKS = 8

MAX_HTML_SIZE = 100 * 1024
MAX_ARIA_CONTEXT_SIZE = 2 * 1024

@dataclass
class Node:
    page_url: str
    html_snapshot: str
    aria_snapshot: str
    dom_snapshot: str
    title: str
    heading: str
    timestamp: str
    visited_at: str
    state_hash: str

@dataclass
class Interaction:
    selector: str
    text: str
    action_type: str  # click, input, select, navigate, submit
    href: Optional[str] = None
    role: Optional[str] = None
    name: Optional[str] = None
    ref_id: Optional[str] = None
    input_value: Optional[str] = None
    selected_value: Optional[str] = None
    form_id: Optional[str] = None

@dataclass
class QueueItem:
    node: Node
    depth: int

class WebCrawler:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.neo4j_driver = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.visited_states: Set[str] = set()
        self.queue: List[QueueItem] = []
        self.semaphore = asyncio.Semaphore(config['parallel_tasks'])
        self.playwright = None
        
    async def __aenter__(self):
        await self.initialize()
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.cleanup()
        
    async def initialize(self):
        self.neo4j_driver = AsyncGraphDatabase.driver(
            self.config['neo4j_uri'],
            auth=(self.config['neo4j_user'], self.config['neo4j_password'])
        )
        
        await self._init_database()
        
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            headless=not self.config.get('headful', False)
        )
        self.context = await self.browser.new_context()
        
    async def cleanup(self):
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
        if self.neo4j_driver:
            await self.neo4j_driver.close()
            
    async def _init_database(self):
        async with self.neo4j_driver.session() as session:
            # Drop all constraints and indexes first
            try:
                await session.run("DROP CONSTRAINT node_state_hash IF EXISTS")
                await session.run("DROP CONSTRAINT node_url IF EXISTS") 
                await session.run("DROP INDEX node_state_hash IF EXISTS")
                await session.run("DROP INDEX node_url IF EXISTS")
                logger.info("Dropped existing constraints and indexes")
            except Exception as e:
                logger.info(f"No existing constraints/indexes to drop: {e}")
                
            # Delete all nodes and relationships completely
            await session.run("MATCH (n) DETACH DELETE n")
            logger.info("Database cleared - all nodes and relationships deleted")
            
            # Create indexes for Page only
            await session.run("CREATE INDEX node_state_hash IF NOT EXISTS FOR (n:Page) ON (n.state_hash)")
            await session.run("CREATE INDEX node_url IF NOT EXISTS FOR (n:Page) ON (n.page_url)")
            logger.info("Indexes created for Page")
            
    async def run(self):
        page = await self.context.new_page()
        
        try:
            # Capture pre-login
            await page.goto(self.config['target_url'], wait_until='networkidle')
            pre_login_node = await self._capture_node(page)
            await self._save_node(pre_login_node)
            self.visited_states.add(pre_login_node.state_hash)
            
            await self._login(page)
            
            post_login_node = await self._capture_node(page)
            await self._save_node(post_login_node)
            await self._create_relation(pre_login_node, post_login_node, Interaction('', '', 'submit'))  # Assume login as submit
            
            self.queue.append(QueueItem(post_login_node, 0))
            self.visited_states.add(post_login_node.state_hash)
            visited_count = 2
            
            exhaustive = self.config.get('exhaustive', False)
            
            while self.queue:
                if not exhaustive and visited_count >= self.config['max_states']:
                    logger.info(f"Reached max states limit {self.config['max_states']}")
                    break
                    
                current_item = self.queue.pop(0)
                
                if not exhaustive and current_item.depth >= self.config['max_depth']:
                    continue
                    
                logger.info(f"Processing: {current_item.node.title} - {current_item.node.page_url} (depth {current_item.depth})")
                
                await page.goto(current_item.node.page_url, wait_until='networkidle')
                await page.wait_for_timeout(5000)
                
                interactions = await self._interactions_from_snapshot(current_item.node.aria_snapshot)
                
                tasks = []
                for interaction in interactions[:50]:
                    task = self._process_interaction(
                        page, current_item.node, interaction, current_item.depth
                    )
                    tasks.append(task)
                    
                results = await self._gather_with_semaphore(tasks)
                
                for new_node in results:
                    if new_node and new_node.state_hash not in self.visited_states:
                        self.visited_states.add(new_node.state_hash)
                        self.queue.append(QueueItem(new_node, current_item.depth + 1))
                        visited_count += 1
                        
        except Exception as e:
            logger.error(f"Error during crawl: {e}")
            raise
        finally:
            await page.close()
            
        logger.info(f"Crawl completed! Total states: {visited_count}")
        
    async def _login(self, page: Page):
        await page.goto(self.config['target_url'], wait_until='load', timeout=60000)
        try:
            await page.wait_for_load_state('networkidle', timeout=10000)
        except PlaywrightTimeoutError:
            logger.info("networkidle timeout, continuing")
        await page.wait_for_timeout(5000)
        
        current_url = page.url
        logger.info(f"Current URL: {current_url}")
        
        is_already_logged_in = await page.evaluate(""" () => !!(document.querySelector('.sidebar') || document.querySelector('.main-content') || document.querySelector('.rc-room')) """)
        
        if is_already_logged_in:
            logger.info("Already logged in")
            return
        
        if '/home' in current_url:
            base_url = self.config['target_url'].rstrip('/home')
            await page.goto(base_url)
            await page.wait_for_load_state('networkidle')
            await page.wait_for_timeout(2000)
        
        login_input = await page.query_selector('input[name="emailOrUsername"], input[name="username"], input[name="email"], input[type="email"], input[type="text"][placeholder*="user" i]')
        password_input = await page.query_selector('input[type="password"]')
        submit_button = await page.query_selector('button.login, button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")')
        
        if login_input and password_input and submit_button:
            await login_input.fill(self.config['login_user'])
            await password_input.fill(self.config['login_pass'])
            await submit_button.click()
            await page.wait_for_timeout(5000)
            is_logged_in = await page.evaluate(""" () => !!(document.querySelector('.sidebar') || document.querySelector('.main-content') || document.querySelector('.rc-room')) """)
            if is_logged_in:
                logger.info("Login successful")
            else:
                logger.warning("Login confirmation elements not found")
        else:
            logger.info("Login form not found, continuing")

    async def _capture_node(self, page: Page) -> Node:
        await page.wait_for_load_state('networkidle')
        
        url = page.url
        title = await page.title()
        html = await page.content()
        if len(html.encode('utf-8')) > MAX_HTML_SIZE:
            html = html[:MAX_HTML_SIZE]
        
        aria_snapshot = json.dumps(await self._get_aria_snapshot(page), ensure_ascii=False)
        
        dom_snapshot = json.dumps(await self._get_dom_snapshot(page), ensure_ascii=False)
        
        headings = json.dumps(await page.evaluate('''() => Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.textContent.trim())'''), ensure_ascii=False)
        
        timestamp = datetime.now().isoformat()
        content_for_hash = url + title + html
        visited_at = hashlib.sha256(content_for_hash.encode()).hexdigest()[:16]
        state_hash = hashlib.sha256((url + visited_at).encode()).hexdigest()[:16]
        
        return Node(
            page_url=url,
            html_snapshot=html,
            aria_snapshot=aria_snapshot,
            dom_snapshot=dom_snapshot,
            title=title,
            heading=headings,
            timestamp=timestamp,
            visited_at=visited_at,
            state_hash=state_hash
        )
        
    async def _get_aria_snapshot(self, page: Page) -> List[Dict[str, Any]]:
        return await page.evaluate('''
            () => {
                const maxDepth = 3;
                const result = [];
                
                function getCssSelector(el) {
                    if (!(el instanceof Element)) return '';
                    const path = [];
                    while (el.nodeType === Node.ELEMENT_NODE) {
                        let selector = el.nodeName.toLowerCase();
                        if (el.id) {
                            selector += '#' + el.id;
                            path.unshift(selector);
                            break;
                        } else {
                            let sib = el, nth = 1;
                            while (sib = sib.previousElementSibling) {
                                if (sib.nodeName.toLowerCase() === selector) nth++;
                            }
                            if (nth !== 1) selector += ":nth-of-type(" + nth + ")";
                        }
                        path.unshift(selector);
                        el = el.parentNode;
                    }
                    return path.join(" > ");
                }
                
                function extractElement(el, depth) {
                    if (depth > maxDepth) return null;
                    
                    const data = {
                        role: el.getAttribute('role') || el.tagName.toLowerCase(),
                        name: el.getAttribute('aria-label') || el.getAttribute('name') || (el.textContent?.trim().slice(0, 100) || ''),
                        ref_id: el.getAttribute('id') || el.getAttribute('data-qa') || null,
                        href: el.getAttribute('href') || null,
                        selector: getCssSelector(el)
                    };
                    
                    data.bbox = el.getBoundingClientRect();
                    data.bbox = {x: data.bbox.x, y: data.bbox.y, width: data.bbox.width, height: data.bbox.height};
                    
                    Object.keys(data).forEach(key => {
                        if (key !== 'role' && !data[key]) delete data[key];
                    });
                    
                    if (data.role || data.name) {
                        return data;
                    }
                    return null;
                }
                
                const candidates = document.querySelectorAll('a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="button"], input[type="submit"], [role="navigation"], [role="region"], [role="group"]');
                candidates.forEach(el => {
                    const data = extractElement(el, 0);
                    if (data && Object.keys(data).length > 1 && data.selector) {
                        result.push(data);
                    }
                });
                
                return result.slice(0, 1000);
            }
        ''')
        
    async def _get_dom_snapshot(self, page: Page) -> List[Dict[str, Any]]:
        return await page.evaluate('''
            () => {
                function getXPath(el) {
                    const parts = [];
                    while (el && el.nodeType === 1) {
                        let pos = 1;
                        let sib = el.previousSibling;
                        while (sib) {
                            if (sib.nodeType === 1 && sib.tagName === el.tagName) pos++;
                            sib = sib.previousSibling;
                        }
                        parts.unshift(`${el.tagName.toLowerCase()}[${pos}]`);
                        el = el.parentNode;
                    }
                    return '/' + parts.join('/');
                }
                
                function getCssSelector(el) {
                    if (!(el instanceof Element)) return '';
                    const path = [];
                    while (el.nodeType === Node.ELEMENT_NODE) {
                        let selector = el.nodeName.toLowerCase();
                        if (el.id) {
                            selector += '#' + el.id;
                            path.unshift(selector);
                            break;
                        } else {
                            let sib = el, nth = 1;
                            while (sib = sib.previousElementSibling) {
                                if (sib.nodeName.toLowerCase() === selector) nth++;
                            }
                            if (nth !== 1) selector += ":nth-of-type(" + nth + ")";
                        }
                        path.unshift(selector);
                        el = el.parentNode;
                    }
                    return path.join(" > ");
                }
                
                const elements = document.querySelectorAll('*');
                return Array.from(elements).slice(0, 100).map(el => ({
                    tag: el.tagName.toLowerCase(),
                    id: el.id,
                    class: el.className,
                    xpath: getXPath(el),
                    css: getCssSelector(el)
                }));
            }
        ''')
        
    async def _interactions_from_snapshot(self, snapshot: str) -> List[Interaction]:
        items = json.loads(snapshot)
        interactions = []
        for item in items:
            role = item.get('role', '').lower()
            if role in ['textbox', 'input'] or item.get('tag') == 'input':
                action_type = 'input'
            elif role == 'select' or item.get('tag') == 'select':
                action_type = 'select'
            elif role in ['button', 'submit'] or item.get('type') == 'submit':
                action_type = 'submit'
            elif item.get('href'):
                action_type = 'navigate'
            else:
                action_type = 'click'
            interactions.append(Interaction(
                selector=item['selector'],
                text=item.get('name', 'unnamed'),
                action_type=action_type,
                href=item.get('href'),
                role=role,
                name=item.get('name'),
                ref_id=item.get('ref_id')
            ))
        return interactions
        
    async def _process_interaction(self, page: Page, from_node: Node, interaction: Interaction, depth: int) -> Optional[Node]:
        async with self.semaphore:
            new_page = await self.context.new_page()
            try:
                await new_page.goto(from_node.page_url, wait_until='networkidle')
                await new_page.wait_for_timeout(5000)
                
                if interaction.action_type == 'navigate' and interaction.href:
                    target_url = urljoin(from_node.page_url, interaction.href)
                    if not self._is_internal_link(target_url):
                        return None
                    await new_page.goto(target_url, wait_until='networkidle')
                elif interaction.action_type == 'click':
                    el = await new_page.wait_for_selector(interaction.selector, timeout=10000)
                    await el.click()
                    await new_page.wait_for_load_state('networkidle')
                elif interaction.action_type == 'input':
                    el = await new_page.wait_for_selector(interaction.selector, timeout=10000)
                    await el.fill(interaction.input_value or 'test')
                    await new_page.wait_for_load_state('networkidle')
                elif interaction.action_type == 'select':
                    el = await new_page.wait_for_selector(interaction.selector, timeout=10000)
                    await el.select_option(interaction.selected_value or 'first_option')  # Placeholder
                    await new_page.wait_for_load_state('networkidle')
                elif interaction.action_type == 'submit':
                    el = await new_page.wait_for_selector(interaction.selector, timeout=10000)
                    await el.click()  # Assuming submit is a button click
                    await new_page.wait_for_load_state('networkidle')
                
                new_node = await self._capture_node(new_page)
                
                await self._save_node(new_node)
                await self._create_relation(from_node, new_node, interaction)
                
                return new_node
            finally:
                await new_page.close()
                
    async def _create_relation(self, from_node: Node, to_node: Node, interaction: Interaction):
        rel_type = {
            'click': 'CLICK_TO',
            'input': 'INPUT_TO',
            'select': 'SELECT_TO',
            'navigate': 'NAVIGATE_TO',
            'submit': 'SUBMIT_TO'
        }.get(interaction.action_type, 'NAVIGATE_TO')
        
        props = {
            'element_id': interaction.selector,
            'action_type': interaction.action_type
        }
        if interaction.action_type == 'click':
            props['element_type'] = interaction.role or 'button'
        elif interaction.action_type == 'input':
            props['input_value'] = interaction.input_value
            props['required_value'] = 'test'  # Placeholder
        elif interaction.action_type == 'select':
            props['selected_value'] = interaction.selected_value or 'test'
        elif interaction.action_type == 'submit':
            props['form_id'] = interaction.form_id or 'unknown'
            props['action_url'] = to_node.page_url
        elif interaction.action_type == 'navigate':
            props['url'] = interaction.href
            props['navigation_type'] = 'link'
        # Add for others
        
        props['conditions'] = json.dumps({'auth_required': True})  # Example
        
        query = f"""
            MATCH (a:Page {{state_hash: $from_hash}})
            MATCH (b:Page {{state_hash: $to_hash}})
            MERGE (a)-[r:{rel_type} {{element_id: $element_id, action_type: $action_type}}]->(b)
            SET r += $props
        """
        async with self.neo4j_driver.session() as session:
            await session.run(query, from_hash=from_node.state_hash, to_hash=to_node.state_hash, props=props, **props)
            
    async def _save_node(self, node: Node):
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MERGE (n:Page {state_hash: $state_hash})
                SET n.page_url = $page_url, n.html_snapshot = $html_snapshot,
                    n.aria_snapshot = $aria_snapshot, n.dom_snapshot = $dom_snapshot,
                    n.title = $title, n.heading = $heading, n.timestamp = $timestamp,
                    n.visited_at = $visited_at
                """,
                **node.__dict__
            )
            
    def _is_internal_link(self, url: str) -> bool:
        base_domain = urlparse(self.config['target_url']).netloc
        target_domain = urlparse(url).netloc
        return base_domain == target_domain
        
    async def _gather_with_semaphore(self, tasks: List) -> List:
        results = []
        batch_size = self.config['parallel_tasks']
        for i in range(0, len(tasks), batch_size):
            batch = tasks[i:i + batch_size]
            batch_results = await asyncio.gather(*batch, return_exceptions=True)
            for result in batch_results:
                if isinstance(result, Exception):
                    logger.info(f"Task error: {result}")
                else:
                    results.append(result)
        return results

async def main():
    parser = argparse.ArgumentParser(description='Web application state graph crawler')
    parser.add_argument('--url', default=TARGET_URL, help='Target URL to crawl')
    parser.add_argument('--user', default=LOGIN_USER, help='Login username')
    parser.add_argument('--password', default=LOGIN_PASS, help='Login password')
    parser.add_argument('--depth', type=int, default=MAX_DEPTH, help='Max exploration depth')
    parser.add_argument('--limit', type=int, default=MAX_STATES, help='Max states')
    parser.add_argument('--headful', action='store_true', help='Show browser')
    parser.add_argument('--parallel', type=int, default=PARALLEL_TASKS, help='Parallel tasks')
    parser.add_argument('--no-clear', action='store_true', help='Do not clear database')
    parser.add_argument('--exhaustive', action='store_true', help='Exhaustive crawl ignoring limits')
    
    args = parser.parse_args()
    
    logging.basicConfig(level=logging.DEBUG if args.headful else logging.INFO, format='%(asctime)s %(levelname)-5s %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
    
    config = {
        'neo4j_uri': NEO4J_URI,
        'neo4j_user': NEO4J_USER,
        'neo4j_password': NEO4J_PASSWORD,
        'target_url': args.url,
        'login_user': args.user,
        'login_pass': args.password,
        'max_depth': args.depth,
        'max_states': args.limit,
        'headful': args.headful,
        'parallel_tasks': args.parallel,
        'clear_db': not args.no_clear,
        'exhaustive': args.exhaustive
    }
    
    async with WebCrawler(config) as crawler:
        await crawler.run()

if __name__ == '__main__':
    asyncio.run(main()) 