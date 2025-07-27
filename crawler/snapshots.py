# snapshots.py
import json
import hashlib
from datetime import datetime
from typing import List, Dict, Any
from playwright.async_api import Page
from .models import Node

async def capture_node(page: Page) -> Node:
    await page.wait_for_load_state('networkidle')
    
    url = page.url
    title = await page.title()
    html = await page.content()
    from .constants import MAX_HTML_SIZE
    if len(html.encode('utf-8')) > MAX_HTML_SIZE:
        html = html[:MAX_HTML_SIZE]
    
    aria_snapshot = json.dumps(await get_aria_snapshot(page), ensure_ascii=False)
    
    dom_snapshot = json.dumps(await get_dom_snapshot(page), ensure_ascii=False)
    
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

async def get_aria_snapshot(page: Page) -> List[Dict[str, Any]]:
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

async def get_dom_snapshot(page: Page) -> List[Dict[str, Any]]:
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