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

async def process_interaction(context, semaphore, from_node: Node, interaction: Interaction, config) -> Optional[Node]:
    async with semaphore:
        new_page = await context.new_page()
        try:
            await new_page.goto(from_node.page_url, wait_until='networkidle')
            await new_page.wait_for_timeout(5000)
            
            if interaction.action_type == 'navigate' and interaction.href:
                target_url = urljoin(from_node.page_url, interaction.href)
                if not is_internal_link(config, target_url):
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
            
            new_node = await capture_node(new_page)
            
            # save_node and create_relation are in database.py, call them in crawler
            return new_node
        finally:
            await new_page.close() 