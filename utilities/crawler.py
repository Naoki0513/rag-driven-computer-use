"""
Web アプリケーション状態グラフクローラー

任意のWebアプリを巡回し、ページ状態をノード、要素クリックによる遷移をエッジとして
Neo4jグラフデータベースに保存する高速並列クローラー。
"""

import asyncio
import argparse
import hashlib
import json
import base64
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple, Set, NamedTuple
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

from playwright.async_api import async_playwright, Page, Browser, BrowserContext, TimeoutError as PlaywrightTimeoutError
from neo4j import AsyncGraphDatabase, AsyncSession

# ロガー設定
logger = logging.getLogger(__name__)


# 設定定数
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

TARGET_URL = "http://the-agent-company.com:3000/"  # 引数で上書き可
LOGIN_USER = "theagentcompany"              # 引数で設定
LOGIN_PASS = "theagentcompany"
MAX_STATES = 10000                  # 安全停止上限（大幅に増加）
MAX_DEPTH = 20                      # 探索深度（大幅に増加）
PARALLEL_TASKS = 8                  # await asyncio.Semaphore で制御

# HTML保存サイズ上限
MAX_HTML_SIZE = 100 * 1024  # 100KB
MAX_ARIA_CONTEXT_SIZE = 2 * 1024  # 2KB


@dataclass
class PageState:
    """ページ状態を表すデータクラス"""
    hash: str
    url: str
    title: str
    state_type: str
    html: str
    aria_snapshot: str
    timestamp: str
    visited_hash: str


@dataclass
class Interaction:
    """インタラクション要素を表すデータクラス"""
    selector: str
    text: str
    action_type: str  # click or navigate
    href: Optional[str] = None
    role: Optional[str] = None
    name: Optional[str] = None
    ref_id: Optional[str] = None


@dataclass
class PageNode:
    hash: str
    url: str
    title: str
    template_id: str
    aria_yaml: str
    dom_hash: str
    embedding: str = ""

@dataclass
class ElementNode:
    element_id: str
    role: str
    name: str
    selector: str
    bbox: str  # JSON文字列
    action_types: List[str]
    visibility: bool

@dataclass
class FormNode:
    form_id: str
    method: str
    action: str
    required_fields: List[str]

@dataclass
class SessionStateNode:
    auth: bool
    cookies: str  # JSON
    query_params: str  # JSON

@dataclass
class QueueItem:
    """BFSキューのアイテム"""
    page: PageNode
    depth: int


class WebCrawler:
    """Webアプリケーション状態グラフクローラー"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.neo4j_driver = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.visited_states: Set[str] = set()
        self.queue: List[QueueItem] = []
        self.semaphore = asyncio.Semaphore(config['parallel_tasks'])
        self.playwright = None
        self.session_state: Optional[SessionStateNode] = None
        
    async def __aenter__(self):
        """非同期コンテキストマネージャーのエントリー"""
        await self.initialize()
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """非同期コンテキストマネージャーのエグジット"""
        await self.cleanup()
        
    async def initialize(self):
        """クローラーの初期化"""
        # Neo4j接続
        self.neo4j_driver = AsyncGraphDatabase.driver(
            self.config['neo4j_uri'],
            auth=(self.config['neo4j_user'], self.config['neo4j_password'])
        )
        
        # データベース初期化
        await self._init_database()
        
        # Playwright初期化
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            headless=not self.config.get('headful', False)
        )
        self.context = await self.browser.new_context()
        
    async def cleanup(self):
        """リソースのクリーンアップ"""
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
        if self.neo4j_driver:
            await self.neo4j_driver.close()
            
    async def _init_database(self):
        """Neo4jデータベースの初期化"""
        async with self.neo4j_driver.session() as session:
            # 開発用: 既存データ削除
            if self.config.get('clear_db', True):
                await session.run("MATCH (n) DETACH DELETE n")
                
            # インデックス作成
            await session.run(
                "CREATE INDEX state_hash IF NOT EXISTS FOR (s:State) ON (s.hash)"
            )
            await session.run(
                "CREATE INDEX transition_key IF NOT EXISTS "
                "FOR ()-[t:TRANSITION]-() ON (t.element_selector)"
            )
            # 新インデックス
            await session.run("CREATE INDEX page_hash IF NOT EXISTS FOR (p:Page) ON (p.hash)")
            await session.run("CREATE INDEX element_id IF NOT EXISTS FOR (e:Element) ON (e.element_id)")
            await session.run("CREATE INDEX form_id IF NOT EXISTS FOR (f:Form) ON (f.form_id)")
            await session.run("CREATE INDEX state_auth IF NOT EXISTS FOR (s:SessionState) ON (s.auth)")
            
    async def run(self):
        """メインクロール処理"""
        page = await self.context.new_page()
        
        try:
            # ログイン処理
            await self._login(page)
            
            # セッション状態作成
            self.session_state = await self._capture_session_state(page)
            await self._save_session_state(self.session_state)
            
            initial_page = await self._capture_page(page)
            await self._save_page(initial_page)
            await self._link_session_to_page(self.session_state, initial_page)
            
            # 要素とフォーム抽出・保存
            elements = await self._extract_elements(page, initial_page.aria_yaml)
            for el in elements:
                await self._save_element(el)
                await self._link_page_to_element(initial_page, el)
            forms = await self._extract_forms(page)
            for form in forms:
                await self._save_form(form)
                # フォームフィールドリンク (簡易)
                for field in form.required_fields:
                    # 仮定: fieldがselector
                    dummy_el = ElementNode(field, 'input', 'field', field, json.dumps({}), ['fill'], True)
                    await self._save_element(dummy_el)
                    await self._link_form_to_field(form, dummy_el)
            
            self.queue.append(QueueItem(initial_page, 0))
            self.visited_states.add(initial_page.hash)  # hashで訪問管理
            
            # BFSループ (調整)
            visited_count = 1
            exhaustive = self.config.get('exhaustive', False)
            
            while self.queue:
                # 制限チェック（exhaustiveモードでない場合のみ）
                if not exhaustive and visited_count >= self.config['max_states']:
                    logger.info(f"状態数の上限 {self.config['max_states']} に達しました")
                    break
                    
                current_item = self.queue.pop(0)
                
                if not self.config.get('exhaustive', False) and current_item.depth >= self.config['max_depth']:
                    logger.debug(f"深度制限 {self.config['max_depth']} に達しました")
                    continue
                    
                logger.info(
                    f"[{visited_count}/{self.config['max_states']}] "
                    f"Processing: {current_item.page.title} - "
                    f"{current_item.page.url} (depth {current_item.depth})"
                )
                
                # ページに移動
                await page.goto(current_item.page.url, wait_until='networkidle')
                await page.wait_for_timeout(5000)  # 追加待機
                
                # インタラクション要素を探す
                # interactions = await self._find_interactions(page)
                interactions = await self._interactions_from_snapshot(current_item.page.aria_yaml)
                
                # 並列処理でインタラクションを実行
                tasks = []
                for interaction in interactions[:50]:  # 各ページ最大50個
                    task = self._process_interaction(
                        page, current_item.page, interaction, current_item.depth
                    )
                    tasks.append(task)
                    
                results = await self._gather_with_semaphore(tasks)
                
                # 新しい状態をキューに追加
                for new_page_node, transition in results:
                    if new_page_node and new_page_node.hash not in self.visited_states:
                        self.visited_states.add(new_page_node.hash)
                        self.queue.append(QueueItem(new_page_node, current_item.depth + 1))
                        visited_count += 1
                        
        except Exception as e:
            logger.error(f"クロール中にエラーが発生: {e}")
            raise
        finally:
            await page.close()
            
        logger.info(f"\nクロール完了！\n総状態数: {visited_count}\n未探索キュー: {len(self.queue)}")
        
        # 統計情報を表示
        async with self.neo4j_driver.session() as session:
            result = await session.run(
                "MATCH (p:Page) RETURN count(p) as nodeCount"
            )
            record = await result.single()
            node_count = record['nodeCount']
            
            result = await session.run(
                "MATCH ()-[r]->() RETURN count(r) as edgeCount"
            )
            record = await result.single()
            edge_count = record['edgeCount']
            
            logger.info(f"\nNeo4jデータベース統計:\nノード数: {node_count}\nエッジ数: {edge_count}")
        
    async def _login(self, page: Page):
        """ログイン処理"""
        # まずベースURLにアクセス
        await page.goto(self.config['target_url'], wait_until='load', timeout=60000)
        
        # ページが完全に読み込まれるまで待機
        try:
            await page.wait_for_load_state('networkidle', timeout=10000)
        except PlaywrightTimeoutError:
            logger.info("networkidleタイムアウト、継続します")
        await page.wait_for_timeout(5000)  # 動的コンテンツのための追加待機
        
        current_url = page.url
        logger.info(f"現在のURL: {current_url}")
        
        # すでにログイン済みかチェック
        is_already_logged_in = await page.evaluate("""
            () => !!(document.querySelector('.sidebar') || 
                     document.querySelector('.main-content') ||
                     document.querySelector('.rc-room'))
        """)
        
        if is_already_logged_in:
            logger.info("すでにログイン済みのようです")
            return
        
        # ログインページでない場合は、/homeから/にリダイレクト
        if '/home' in current_url:
            logger.info("ログインページに移動")
            base_url = self.config['target_url'].rstrip('/home')
            await page.goto(base_url)
            await page.wait_for_load_state('networkidle')
            await page.wait_for_timeout(2000)
        
        # デバッグ: ページのHTMLを一部出力
        html = await page.content()
        logger.debug(f"ページHTML（最初の1000文字）: {html[:1000]}")
        
        # ログインフォームの検出（複数のパターンに対応）
        login_input = await page.query_selector(
            'input[name="emailOrUsername"], input[name="username"], '
            'input[name="email"], input[type="email"], input[type="text"][placeholder*="user" i]'
        )
        password_input = await page.query_selector('input[type="password"]')
        submit_button = await page.query_selector(
            'button.login, button[type="submit"], input[type="submit"], '
            'button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")'
        )
        
        # デバッグ情報
        logger.info(f"ログイン要素検出: login_input={login_input is not None}, "
                   f"password_input={password_input is not None}, "
                   f"submit_button={submit_button is not None}")
        
        # JavaScriptでも要素を探す
        if not (login_input and password_input and submit_button):
            logger.info("JavaScriptで要素を再検索")
            elements_found = await page.evaluate("""
                () => {
                    const loginInput = document.querySelector('input[name="emailOrUsername"]');
                    const passwordInput = document.querySelector('input[type="password"]');
                    const submitButton = document.querySelector('button.login');
                    
                    return {
                        hasLoginInput: !!loginInput,
                        hasPasswordInput: !!passwordInput,
                        hasSubmitButton: !!submitButton,
                        loginInputDetails: loginInput ? {
                            name: loginInput.name,
                            type: loginInput.type,
                            placeholder: loginInput.placeholder
                        } : null,
                        submitButtonDetails: submitButton ? {
                            text: submitButton.textContent,
                            className: submitButton.className
                        } : null
                    };
                }
            """)
            logger.info(f"JavaScript要素検索結果: {elements_found}")
        
        if login_input and password_input and submit_button:
            logger.info("ログインフォームを検出、認証を実行")
            await login_input.fill(self.config['login_user'])
            await password_input.fill(self.config['login_pass'])
            await submit_button.click()
            
            # 認証成功を確認
            try:
                # ログイン後の読み込みを待つ
                await page.wait_for_timeout(5000)
                
                # ログイン成功を確認
                is_logged_in = await page.evaluate("""
                    () => !!(document.querySelector('.sidebar') || 
                             document.querySelector('.main-content') ||
                             document.querySelector('.rc-room'))
                """)
                
                if is_logged_in:
                    logger.info("ログイン成功")
                else:
                    logger.warning("ログイン後の確認要素が見つかりません")
            except PlaywrightTimeoutError:
                logger.info("ログインタイムアウト")
        else:
            logger.info("ログインフォームが見つかりません、継続します")
            
    async def _capture_page(self, page: Page) -> PageNode:
        """ページ状態をキャプチャ"""
        await page.wait_for_load_state('networkidle')
        
        # 基本情報取得
        url = page.url
        title = await page.title()
        html = await page.content()
        
        # HTMLサイズ制限
        if len(html.encode('utf-8')) > MAX_HTML_SIZE:
            html = html[:MAX_HTML_SIZE]
        
        # ARIA snapshot取得
        snapshot = await self._get_aria_snapshot(page)
        aria_yaml = json.dumps(snapshot, ensure_ascii=False)  # JSONとして格納
        
        # ノードハッシュ - URLベース
        node_hash = hashlib.sha256(url.encode()).hexdigest()[:16]
        # 訪問済みチェック用ハッシュ - コンテンツベース
        visited_hash = hashlib.sha256((url + title + html).encode()).hexdigest()[:16]
        
        # タイムスタンプ
        timestamp = datetime.now().isoformat()
        
        # テンプレートID
        template_id = hashlib.sha256(url.encode()).hexdigest()[:8]
        
        return PageNode(
            hash=node_hash,  # DB用
            url=url,
            title=title,
            template_id=template_id,
            aria_yaml=aria_yaml,
            dom_hash=hashlib.sha256(html.encode()).hexdigest()[:16],
            embedding="" # 現在は空
        )
        
    async def _get_aria_snapshot(self, page: Page) -> List[Dict[str, Any]]:
        """ARIA snapshotを取得"""
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
                    
                    // bbox追加
                    data.bbox = el.getBoundingClientRect();
                    data.bbox = {x: data.bbox.x, y: data.bbox.y, width: data.bbox.width, height: data.bbox.height};
                    
                    // 空の値を除去（ただしroleは必須）
                    Object.keys(data).forEach(key => {
                        if (key !== 'role' && !data[key]) delete data[key];
                    });
                    
                    // roleかnameのどちらかが存在する場合のみ
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
                
                return result.slice(0, 1000);  // 最大1000要素
            }
        ''')
        
    async def _interactions_from_snapshot(self, snapshot: str) -> List[Interaction]:
        """保存されたARIA snapshotからインタラクションを生成"""
        items = json.loads(snapshot)
        interactions = []
        for item in items:
            if not item.get('selector'):
                continue
            action_type = 'navigate' if item.get('href') else 'click'
            interactions.append(Interaction(
                selector=item['selector'],
                text=item.get('name', 'unnamed'),
                action_type=action_type,
                href=item.get('href'),
                role=item.get('role', 'unknown'),
                name=item.get('name', 'unnamed'),
                ref_id=item.get('ref_id', 'no_id')
            ))
        return interactions
        
    async def _process_interaction(
        self,
        page: Page,
        from_page: PageNode,
        interaction: Interaction,
        depth: int
    ) -> Tuple[Optional[PageNode], Optional[Any]]:
        """インタラクションを処理"""
        async with self.semaphore:
            new_page = await self.context.new_page()
            
            try:
                # 元のページに移動
                await new_page.goto(from_page.url, wait_until='networkidle')
                await new_page.wait_for_timeout(5000)  # 追加待機
                
                # インタラクション実行
                if interaction.action_type == 'navigate' and interaction.href:
                    # URL遷移
                    target_url = urljoin(from_page.url, interaction.href)
                    
                    # 内部リンクチェック
                    if not self._is_internal_link(target_url):
                        return None, None
                        
                    await new_page.goto(target_url, wait_until='networkidle')
                    
                else:
                    # クリック
                    try:
                        element = await new_page.wait_for_selector(interaction.selector, state='visible', timeout=10000)
                        if element and await element.is_enabled():
                            await element.click(force=True)
                            await new_page.wait_for_load_state('networkidle', timeout=30000)
                        else:
                            return None, None
                    except PlaywrightTimeoutError:
                        logger.info(f"Selector {interaction.selector} not found or not visible")
                        return None, None
                        
                # 新しい状態をキャプチャ
                new_page_node = await self._capture_page(new_page)
                
                # interactionからElement作成 (仮定)
                el = ElementNode(interaction.selector, interaction.role or 'unknown', interaction.name or 'unnamed', interaction.selector, json.dumps({}), ['click'], True)
                await self._save_element(el)
                await self._link_element_to_page(el, new_page_node)
                
                # 遷移情報作成 (リレーション)
                # ここでは、NAVIGATES_TOリレーションを作成
                await self._link_page_to_page(from_page, new_page_node)
                
                # データベースに保存
                await self._save_page(new_page_node)
                logger.info(
                    f"    Transition: {interaction.action_type} "
                    f"'{interaction.text}' -> {new_page_node.title}"
                )
                
                # セッション状態の更新
                self.session_state = await self._capture_session_state(new_page)
                await self._save_session_state(self.session_state)
                
                return new_page_node, None # エッジはリレーションで表現
                
            except (PlaywrightTimeoutError, Exception) as e:
                logger.info(f"インタラクション処理エラー: {e}")
                return None, None
                
            finally:
                await new_page.close()
                
    async def _detect_state_type(self, page: Page) -> str:
        """ページの状態タイプを検出"""
        # URLベースの判定
        url = page.url
        
        if '/channel/' in url:
            return 'channel'
        elif '/direct/' in url:
            return 'dm'
        elif '/thread/' in url:
            return 'thread'
            
        # DOM要素ベースの判定
        if await page.query_selector('.modal'):
            return 'modal'
        elif await page.query_selector('.settings'):
            return 'settings'
        elif await page.query_selector('.profile'):
            return 'profile'
            
        return 'page'
        
    def _is_internal_link(self, url: str) -> bool:
        """内部リンクかどうかを判定"""
        base_domain = urlparse(self.config['target_url']).netloc
        target_domain = urlparse(url).netloc
        return base_domain == target_domain
        
    async def _save_page(self, page_node: PageNode):
        """ページノードをNeo4jに保存"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MERGE (p:Page {hash: $hash})
                SET p.url = $url, p.title = $title, p.template_id = $template_id,
                    p.aria_yaml = $aria_yaml, p.dom_hash = $dom_hash, p.embedding = $embedding
                """,
                **page_node.__dict__
            )
    
    async def _save_element(self, el: ElementNode):
        """要素ノードをNeo4jに保存"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MERGE (e:Element {element_id: $element_id})
                SET e.role = $role, e.name = $name, e.selector = $selector,
                    e.bbox = $bbox, e.action_types = $action_types, e.visibility = $visibility
                """,
                **el.__dict__
            )
    
    async def _save_form(self, form: FormNode):
        """フォームノードをNeo4jに保存"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MERGE (f:Form {form_id: $form_id})
                SET f.method = $method, f.action = $action, f.required_fields = $required_fields
                """,
                **form.__dict__
            )
    
    async def _save_session_state(self, state: SessionStateNode):
        """セッション状態ノードをNeo4jに保存"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MERGE (s:SessionState {auth: $auth})
                SET s.cookies = $cookies, s.query_params = $query_params
                """,
                **state.__dict__
            )
    
    # リレーションリンク関数
    async def _link_page_to_page(self, from_page: PageNode, to_page: PageNode):
        """ページ間のリレーションを作成"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MATCH (p1:Page {hash: $from_hash})
                MATCH (p2:Page {hash: $to_hash})
                MERGE (p1)-[:NAVIGATES_TO]->(p2)
                """,
                from_hash=from_page.hash, to_hash=to_page.hash
            )
    
    async def _link_session_to_page(self, state: SessionStateNode, page: PageNode):
        """セッション状態とページのリレーションを作成"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MATCH (s:SessionState {auth: $auth})
                MATCH (p:Page {hash: $hash})
                MERGE (p)-[:REQUIRES_STATE]->(s)
                """, auth=state.auth, hash=page.hash
            )
    
    async def _link_form_to_field(self, form: FormNode, el: ElementNode):
        """フォームとフィールドのリレーションを作成"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MATCH (f:Form {form_id: $form_id})
                MATCH (e:Element {element_id: $el_id})
                MERGE (f)-[:HAS_FIELD]->(e)
                """,
                form_id=form.form_id, el_id=el.element_id
            )
    
    async def _link_page_to_element(self, page: PageNode, el: ElementNode):
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MATCH (p:Page {hash: $page_hash})
                MATCH (e:Element {element_id: $el_id})
                MERGE (p)-[:HAS_ELEMENT]->(e)
                """,
                page_hash=page.hash, el_id=el.element_id
            )
 
    async def _link_element_to_page(self, el: ElementNode, to_page: PageNode):
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MATCH (e:Element {element_id: $el_id})
                MATCH (p:Page {hash: $page_hash})
                MERGE (e)-[:NAVIGATES_TO]->(p)
                """,
                el_id=el.element_id, page_hash=to_page.hash
            )

    async def _gather_with_semaphore(self, tasks: List) -> List:
        results = []
        batch_size = self.config['parallel_tasks']
        for i in range(0, len(tasks), batch_size):
            batch = tasks[i:i + batch_size]
            batch_results = await asyncio.gather(*batch, return_exceptions=True)
            for result in batch_results:
                if isinstance(result, Exception):
                    logger.info(f"タスクエラー: {result}")
                else:
                    results.append(result)
        return results

    async def _capture_session_state(self, page: Page) -> SessionStateNode:
        cookies = await page.context.cookies()
        return SessionStateNode(True, json.dumps(cookies), json.dumps(dict(urlparse(page.url).query)) or '{}')

    # 他のリレーション (NAVIGATES_TO, PART_OF_FORM, SUBMITS_TO) は_process_interactionで動的に作成

    async def _extract_elements(self, page: Page, aria_yaml: str) -> List[ElementNode]:
        items = json.loads(aria_yaml)
        elements = []
        for item in items:
            el = ElementNode(
                item.get('selector', 'unknown'),
                item.get('role', 'unknown'),
                item.get('name', 'unnamed'),
                item.get('selector', 'unknown'),
                json.dumps(item.get('bbox', {})),
                ['click'] if item.get('role') in ['button', 'link'] else ['fill'],
                True  # 仮定
            )
            elements.append(el)
        return elements

    async def _extract_forms(self, page: Page) -> List[FormNode]:
        forms = await page.evaluate('''
            () => {
                const formList = [];
                document.querySelectorAll('form').forEach(form => {
                    formList.push({
                        form_id: form.id || 'generated_' + Math.random().toString(36),
                        method: form.method || 'GET',
                        action: form.action || '',
                        required_fields: Array.from(form.querySelectorAll('[required]')).map(el => el.name || el.id)
                    });
                });
                return formList;
            }
        ''')
        return [FormNode(f['form_id'], f['method'], f['action'], f['required_fields']) for f in forms]


async def main():
    """メイン関数"""
    # 引数パーサー
    parser = argparse.ArgumentParser(
        description='Web アプリケーション状態グラフクローラー'
    )
    parser.add_argument(
        '--url', default=TARGET_URL,
        help='クロール対象URL'
    )
    parser.add_argument(
        '--user', default=LOGIN_USER,
        help='ログインユーザー名'
    )
    parser.add_argument(
        '--password', default=LOGIN_PASS,
        help='ログインパスワード'
    )
    parser.add_argument(
        '--depth', type=int, default=MAX_DEPTH,
        help='最大探索深度'
    )
    parser.add_argument(
        '--limit', type=int, default=MAX_STATES,
        help='最大状態数'
    )
    parser.add_argument(
        '--headful', action='store_true',
        help='ブラウザを表示'
    )
    parser.add_argument(
        '--parallel', type=int, default=PARALLEL_TASKS,
        help='並列タスク数'
    )
    parser.add_argument(
        '--no-clear', action='store_true',
        help='データベースをクリアしない'
    )
    parser.add_argument(
        '--exhaustive', action='store_true',
        help='すべての状態を探索するまで続ける（制限を無視）'
    )
    
    args = parser.parse_args()
    
    # ロギング設定
    logging.basicConfig(
        level=logging.DEBUG if args.headful else logging.INFO,
        format='%(asctime)s %(levelname)-5s %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    # 設定作成
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
    
    # クローラー実行
    async with WebCrawler(config) as crawler:
        await crawler.run()


if __name__ == '__main__':
    asyncio.run(main())