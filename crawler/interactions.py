# interactions.py
import json
import asyncio
from typing import Optional, List
from urllib.parse import urljoin
from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError
from .models import Node, Interaction
from .utils import is_internal_link
from .snapshots import capture_node
import yaml

async def interactions_from_snapshot(snapshot: str) -> List[Interaction]:
    tree = yaml.safe_load(snapshot)
    interactions = []
    
    def traverse(node):
        role = node.get('role', '').lower()
        if role in ['button', 'link', 'tab', 'menuitem']:
            interactions.append(Interaction(
                selector=None,
                text=node.get('name', 'unnamed'),
                action_type='click',
                href=None,
                role=role,
                name=node.get('name', 'unnamed'),
            ))
        for child in node.get('children', []):
            traverse(child)
    
    traverse(tree)
    return interactions

async def process_interaction(context, semaphore, from_node: Node, interaction: Interaction, config) -> Optional[Node]:
    async with semaphore:
        new_page = await context.new_page()
        try:
            await new_page.goto(from_node.page_url, wait_until='networkidle')
            await new_page.wait_for_timeout(5000)
            
            locator = new_page.get_by_role(interaction.role, name=interaction.name, exact=True)
            
            try:
                await locator.wait_for(state="attached", timeout=10000)
            except PlaywrightTimeoutError:
                return None
            
            href = await locator.get_attribute("href")
            
            if href:
                target_url = urljoin(from_node.page_url, href)
                if not is_internal_link(config, target_url):
                    return None
                await new_page.goto(target_url, wait_until='networkidle')
            else:
                await locator.click()
                await new_page.wait_for_load_state('networkidle')
            
            new_node = await capture_node(new_page)
            return new_node
        except Exception as e:
            print(f"Error: {e}")
            return None
        finally:
            await new_page.close() 