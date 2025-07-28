# snapshots.py
import json
import hashlib
from datetime import datetime
from typing import List, Dict, Any
from playwright.async_api import Page
from .models import Node

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
    
    aria_snapshot = json.dumps(await get_aria_snapshot(page), ensure_ascii=False)
    
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

async def get_aria_snapshot(page: Page) -> List[Dict[str, Any]]:
    return await page.evaluate('''
        () => {
            const maxDepth = 5;
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
                
                const tagName = el.tagName.toLowerCase();
                const role = el.getAttribute('role') || tagName;
                const name = el.getAttribute('aria-label') || 
                           el.getAttribute('name') || 
                           el.getAttribute('title') ||
                           el.getAttribute('alt') ||
                           (el.textContent?.trim().slice(0, 100) || '');
                
                const data = {
                    role: role,
                    name: name,
                    tag: tagName,
                    ref_id: el.getAttribute('id') || el.getAttribute('data-qa') || null,
                    href: el.getAttribute('href') || null,
                    selector: getCssSelector(el)
                };
                
                data.bbox = el.getBoundingClientRect();
                data.bbox = {x: data.bbox.x, y: data.bbox.y, width: data.bbox.width, height: data.bbox.height};
                
                // より柔軟な条件に変更 - 要素のサイズまたはテキストがあれば有効
                if (data.name || data.href || (data.bbox.width > 0 && data.bbox.height > 0)) {
                    return data;
                }
                return null;
            }
            
            // より広範なセレクタで要素を検索
            const candidates = document.querySelectorAll(`
                a, button, input, select, textarea, 
                [role="button"], [role="link"], [role="tab"], [role="menuitem"], 
                [role="navigation"], [role="region"], [role="group"], [role="listitem"],
                [onclick], [href], [data-qa], [data-testid],
                .btn, .button, .link, .menu-item, .nav-item,
                li, span[class*="button"], div[class*="button"], div[class*="clickable"]
            `);
            
            candidates.forEach(el => {
                const data = extractElement(el, 0);
                if (data && data.selector) {
                    result.push(data);
                }
            });
            
            // 最低限の要素が見つからない場合は、すべての表示可能な要素を取得
            if (result.length < 5) {
                const allElements = document.querySelectorAll('*');
                Array.from(allElements).forEach(el => {
                    if (result.length >= 50) return; // 上限設定
                    
                    const bbox = el.getBoundingClientRect();
                    if (bbox.width > 0 && bbox.height > 0) {
                        const data = extractElement(el, 0);
                        if (data && data.selector && !result.some(r => r.selector === data.selector)) {
                            result.push(data);
                        }
                    }
                });
            }
            
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