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
class QueueItem:
    """BFSキューのアイテム"""
    state: PageState
    depth: int


class StateTransition(NamedTuple):
    """状態遷移を表すタプル"""
    from_hash: str
    to_hash: str
    action_type: str
    aria_context: str
    element_selector: str
    element_text: str
    role: str
    name: str
    ref_id: str


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
            
    async def run(self):
        """メインクロール処理"""
        page = await self.context.new_page()
        
        try:
            # ログイン処理
            await self._login(page)
            
            # 初期状態をキャプチャ
            await page.wait_for_timeout(5000)  # 追加待機
            initial_state = await self._capture_state(page, "home")
            await self._save_state(initial_state)
            self.queue.append(QueueItem(initial_state, 0))
            self.visited_states.add(initial_state.hash)
            
            # BFSループ
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
                    f"Processing: {current_item.state.state_type} - "
                    f"{current_item.state.url} (depth {current_item.depth})"
                )
                
                # ページに移動
                await page.goto(current_item.state.url, wait_until='networkidle')
                await page.wait_for_timeout(5000)  # 追加待機
                
                # インタラクション要素を探す
                interactions = await self._find_interactions(page)
                
                # 並列処理でインタラクションを実行
                tasks = []
                for interaction in interactions[:50]:  # 各ページ最大50個
                    task = self._process_interaction(
                        page, current_item.state, interaction, current_item.depth
                    )
                    tasks.append(task)
                    
                results = await self._gather_with_semaphore(tasks)
                
                # 新しい状態をキューに追加
                for new_state, transition in results:
                    if new_state and new_state.hash not in self.visited_states:
                        self.visited_states.add(new_state.hash)
                        self.queue.append(QueueItem(new_state, current_item.depth + 1))
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
                "MATCH (s:State) RETURN count(s) as nodeCount"
            )
            record = await result.single()
            node_count = record['nodeCount']
            
            result = await session.run(
                "MATCH ()-[t:TRANSITION]->() RETURN count(t) as edgeCount"
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
            
    async def _capture_state(self, page: Page, state_type: str) -> PageState:
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
        aria_snapshot = await self._get_aria_snapshot(page)
        
        # ハッシュ生成 - URLベースで同じURLは同じノードとして扱う
        state_hash = hashlib.sha256(url.encode()).hexdigest()[:16]
        
        # タイムスタンプ
        timestamp = datetime.now().isoformat()
        
        return PageState(
            hash=state_hash,
            url=url,
            title=title,
            state_type=state_type,
            html=html,
            aria_snapshot=json.dumps(aria_snapshot, ensure_ascii=False),
            timestamp=timestamp
        )
        
    async def _get_aria_snapshot(self, page: Page) -> List[Dict[str, Any]]:
        """ARIA snapshotを取得"""
        return await page.evaluate('''
            () => {
                const maxDepth = 3;
                const result = [];
                
                function extractElement(el, depth) {
                    if (depth > maxDepth) return null;
                    
                    const data = {
                        role: el.getAttribute('role'),
                        name: el.getAttribute('aria-label') || el.getAttribute('name') || el.textContent?.slice(0, 100),
                        ref_id: el.getAttribute('id') || el.getAttribute('data-qa') || null,
                        href: el.getAttribute('href')
                    };
                    
                    // 空の値を除去
                    Object.keys(data).forEach(key => {
                        if (!data[key]) delete data[key];
                    });
                    
                    return data;
                }
                
                document.querySelectorAll('*').forEach(el => {
                    const data = extractElement(el, 0);
                    if (data && Object.keys(data).length > 1) {
                        result.push(data);
                    }
                });
                
                return result.slice(0, 1000);  // 最大1000要素
            }
        ''')
        
    async def _find_interactions(self, page: Page) -> List[Interaction]:
        """インタラクション可能な要素を検出"""
        interactive_elements = await page.evaluate('''
            () => {
                const elements = [];
                const candidates = document.querySelectorAll('a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="button"], input[type="submit"]');
                candidates.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
                        const data = {
                            tag: el.tagName.toLowerCase(),
                            role: el.getAttribute('role') || el.tagName.toLowerCase(),
                            href: el.getAttribute('href') || null,
                            text: (el.textContent || '').trim().slice(0, 100) || el.getAttribute('aria-label') || el.getAttribute('title') || 'unnamed',
                            id: el.id || null,
                            name: el.getAttribute('name') || el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 50) || 'unnamed'
                        };
                        // ref_idがない場合は生成
                        if (!data.id) {
                            data.id = 'auto_' + Math.random().toString(36).substr(2, 9);
                            el.id = data.id;
                        }
                        elements.push(data);
                    }
                });
                return elements.slice(0, 100); // Limit to 100 to avoid overload
            }
        ''')
        
        interactions = []
        for item in interactive_elements:
            # ref_idベースのセレクターを使用
            if not item.get('id'):
                continue
            
            action_type = 'navigate' if item.get('tag') == 'a' or item.get('href') else 'click'
            selector = f"#{item['id']}"
            
            interactions.append(Interaction(
                selector=selector,
                text=item.get('text', 'unnamed'),
                action_type=action_type,
                href=item.get('href'),
                role=item.get('role', 'unknown'),
                name=item.get('name', 'unnamed'),
                ref_id=item.get('id')
            ))
        
        logger.info(f"Found {len(interactions)} interactions in page")
        return interactions
        
    async def _process_interaction(
        self,
        page: Page,
        from_state: PageState,
        interaction: Interaction,
        depth: int
    ) -> Tuple[Optional[PageState], Optional[StateTransition]]:
        """インタラクションを処理"""
        async with self.semaphore:
            new_page = await self.context.new_page()
            
            try:
                # 元のページに移動
                await new_page.goto(from_state.url, wait_until='networkidle')
                
                # インタラクション実行
                if interaction.action_type == 'navigate' and interaction.href:
                    # URL遷移
                    target_url = urljoin(from_state.url, interaction.href)
                    
                    # 内部リンクチェック
                    if not self._is_internal_link(target_url):
                        return None, None
                        
                    await new_page.goto(target_url, wait_until='networkidle')
                    
                else:
                    # クリック
                    element = await new_page.wait_for_selector(interaction.selector, state='visible', timeout=20000)
                    if element and await element.is_enabled():
                        await element.click()
                        await new_page.wait_for_load_state('networkidle')
                    else:
                        return None, None
                        
                # 新しい状態をキャプチャ
                new_state_type = await self._detect_state_type(new_page)
                new_state = await self._capture_state(new_page, new_state_type)
                
                # ARIA context抽出 - nullを避ける
                aria_context = json.dumps({
                    'role': interaction.role or 'unknown',
                    'name': interaction.name or 'unnamed', 
                    'ref_id': interaction.ref_id or 'no_id'
                }, ensure_ascii=False)[:MAX_ARIA_CONTEXT_SIZE]
                
                # 遷移情報作成
                transition = StateTransition(
                    from_hash=from_state.hash,
                    to_hash=new_state.hash,
                    action_type=interaction.action_type,
                    aria_context=aria_context,
                    element_selector=interaction.selector,
                    element_text=interaction.text,
                    role=interaction.role or 'unknown',
                    name=interaction.name or 'unnamed',
                    ref_id=interaction.ref_id or 'no_id'
                )
                
                # データベースに保存
                if new_state.hash not in self.visited_states:
                    await self._save_state(new_state)
                    logger.info(
                        f"    Transition: {interaction.action_type} "
                        f"'{interaction.text}' -> {new_state.state_type}"
                    )
                    
                await self._save_transition(transition)
                
                return new_state, transition
                
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
        
    async def _save_state(self, state: PageState):
        """状態をNeo4jに保存"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MERGE (s:State {hash: $hash})
                SET s.url = $url,
                    s.title = $title,
                    s.state_type = $state_type,
                    s.html = $html,
                    s.aria_snapshot = $aria_snapshot,
                    s.timestamp = $timestamp
                """,
                hash=state.hash,
                url=state.url,
                title=state.title,
                state_type=state.state_type,
                html=state.html,
                aria_snapshot=state.aria_snapshot,
                timestamp=state.timestamp
            )
            
    async def _save_transition(self, transition: StateTransition):
        """遷移をNeo4jに保存"""
        async with self.neo4j_driver.session() as session:
            await session.run(
                """
                MATCH (from:State {hash: $from_hash})
                MATCH (to:State {hash: $to_hash})
                MERGE (from)-[t:TRANSITION {
                    element_selector: $element_selector
                }]->(to)
                SET t.action_type = $action_type,
                    t.aria_context = $aria_context,
                    t.element_text = $element_text,
                    t.role = $role,
                    t.name = $name,
                    t.ref_id = $ref_id
                """,
                from_hash=transition.from_hash,
                to_hash=transition.to_hash,
                action_type=transition.action_type,
                aria_context=transition.aria_context,
                element_selector=transition.element_selector,
                element_text=transition.element_text,
                role=transition.role,
                name=transition.name,
                ref_id=transition.ref_id
            )
            
    async def _gather_with_semaphore(self, tasks: List) -> List:
        """セマフォで制御された並列実行"""
        results = []
        
        # バッチ処理
        batch_size = self.config['parallel_tasks']
        for i in range(0, len(tasks), batch_size):
            batch = tasks[i:i + batch_size]
            batch_results = await asyncio.gather(*batch, return_exceptions=True)
            
            for result in batch_results:
                if isinstance(result, Exception):
                    logger.info(f"タスクエラー: {result}")
                    results.append((None, None))
                else:
                    results.append(result)
                    
        return results


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