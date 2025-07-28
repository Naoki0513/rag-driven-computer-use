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

# Import constants from constants.py

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

# crawler.py
import asyncio
from typing import Dict, Any, Set, List
from playwright.async_api import async_playwright, Page, Browser, BrowserContext, TimeoutError as PlaywrightTimeoutError
from neo4j import AsyncGraphDatabase
from .constants import *
from .models import Node, Interaction, QueueItem
from .database import init_database, save_node, create_relation
from .snapshots import capture_node
from .interactions import interactions_from_snapshot, process_interaction
from .utils import gather_with_semaphore

class WebCrawler:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.neo4j_driver = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
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
        
        if self.config.get('clear_db', True):
            await init_database(self.neo4j_driver)
        
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
            
    async def run(self):
        page = await self.context.new_page()
        
        try:
            # Capture pre-login
            await page.goto(self.config['target_url'], wait_until='networkidle')
            pre_login_node = await capture_node(page)
            await save_node(self.neo4j_driver, pre_login_node)
            self.visited_states.add(pre_login_node.page_url)
            
            await self._login(page)
            
            post_login_node = await capture_node(page)
            await save_node(self.neo4j_driver, post_login_node)
            await create_relation(self.neo4j_driver, pre_login_node, post_login_node, Interaction('', '', 'submit'))  # Assume login as submit
            
            self.queue.append(QueueItem(post_login_node, 0))
            self.visited_states.add(post_login_node.page_url)
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
                
                interactions = await interactions_from_snapshot(current_item.node.aria_snapshot)
                
                tasks = []
                for interaction in interactions[:50]:
                    task = asyncio.create_task(process_interaction(self.context, self.semaphore, current_item.node, interaction, self.config))
                    tasks.append(task)
                    
                results = await gather_with_semaphore(self.config, tasks)
                
                for new_node in results:
                    if new_node and new_node.page_url not in self.visited_states:
                        await save_node(self.neo4j_driver, new_node)
                        await create_relation(self.neo4j_driver, current_item.node, new_node, interaction)
                        self.visited_states.add(new_node.page_url)
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