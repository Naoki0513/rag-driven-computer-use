# interactions.py
import json
import asyncio
from typing import Optional, List
from urllib.parse import urljoin
from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError
from .models import Node, Interaction
from .utils import is_internal_link
from .snapshots import capture_node

async def interactions_from_snapshot(snapshot: str) -> List[Interaction]:
    items = json.loads(snapshot)
    interactions = []
    for item in items:
        role = item.get('role', '').lower()
        if role in ['button', 'link', 'tab', 'menuitem'] or item.get('href') or item.get('tag') in ['button', 'a']:
            interactions.append(Interaction(
                selector=item['selector'],
                text=item.get('name', 'unnamed'),
                action_type='click',
                href=item.get('href'),
                role=role,
                name=item.get('name', 'unnamed'),
                ref_id=item.get('ref_id')
            ))
    return interactions

async def process_interaction(context, semaphore, from_node: Node, interaction: Interaction, config) -> Optional[Node]:
    async with semaphore:
        new_page = await context.new_page()
        try:
            await new_page.goto(from_node.page_url, wait_until='networkidle')
            await new_page.wait_for_timeout(5000)
            
            if interaction.href:
                target_url = urljoin(from_node.page_url, interaction.href)
                if not is_internal_link(config, target_url):
                    return None
                await new_page.goto(target_url, wait_until='networkidle')
            else:
                el = await new_page.wait_for_selector(interaction.selector, timeout=10000)
                await el.click()
                await new_page.wait_for_load_state('networkidle')
            
            new_node = await capture_node(new_page)
            return new_node
        finally:
            await new_page.close() 