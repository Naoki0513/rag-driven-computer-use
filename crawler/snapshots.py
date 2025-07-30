# snapshots.py
import json
import hashlib
from datetime import datetime
from typing import List, Dict, Any
from playwright.async_api import Page
from .models import Node
import yaml

async def capture_node(page: Page) -> Node:
    await page.wait_for_load_state('networkidle')
    # 動的コンテンツの読み込み完了を待つ
    await page.wait_for_timeout(3000)
    
    url = page.url
    title = await page.title()
    html = await page.content()
    from .constants import MAX_HTML_SIZE
    if len(html.encode('utf-8')) > MAX_HTML_SIZE:
        html = html[:MAX_HTML_SIZE]
    
    tree = await get_aria_snapshot(page)
    aria_snapshot = yaml.dump(tree, allow_unicode=True, default_flow_style=False)
    
    headings = json.dumps(await page.evaluate('''() => Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.textContent.trim())'''), ensure_ascii=False)
    
    timestamp = datetime.now().isoformat()
    
    return Node(
        page_url=url,
        html_snapshot=html,
        aria_snapshot=aria_snapshot,
        title=title,
        heading=headings,
        timestamp=timestamp
    )

async def get_aria_snapshot(page: Page) -> Dict[str, Any]:
    return await page.accessibility.snapshot() 