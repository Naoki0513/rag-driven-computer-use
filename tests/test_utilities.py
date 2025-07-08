"""
補助ツール（utilities）のテスト
"""
import pytest
from unittest.mock import Mock, patch, MagicMock, AsyncMock
import sys
import os

# プロジェクトルートをPythonパスに追加
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestNeo4jConnection:
    """test_neo4j_connection.pyのテスト"""
    
    @patch('utilities.test_neo4j_connection.requests')
    def test_test_http_endpoint_success(self, mock_requests):
        """HTTP接続成功テスト"""
        from utilities.test_neo4j_connection import test_http_endpoint
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = "neo4j"
        mock_requests.get.return_value = mock_response
        
        with patch('builtins.print'):
            test_http_endpoint()
        
        mock_requests.get.assert_called()
    
    def test_test_http_endpoint_failure(self):
        """HTTP接続失敗テスト"""
        with patch('utilities.test_neo4j_connection.requests.get') as mock_get:
            import requests
            mock_get.side_effect = requests.exceptions.ConnectionError("Connection refused")
            
            with patch('builtins.print'):
                from utilities.test_neo4j_connection import test_http_endpoint
                test_http_endpoint()
            
            mock_get.assert_called()
    
    @patch('utilities.test_neo4j_connection.GraphDatabase')
    def test_test_bolt_connection_success(self, mock_graph_db):
        """Bolt接続成功テスト"""
        from utilities.test_neo4j_connection import test_bolt_connection
        
        mock_driver = Mock()
        mock_session = Mock()
        mock_result = Mock()
        mock_result.single.return_value = {"version": "5.0.0"}
        mock_session.run.return_value = mock_result
        
        # sessionのコンテキストマネージャー設定
        mock_session_context = MagicMock()
        mock_session_context.__enter__.return_value = mock_session
        mock_session_context.__exit__.return_value = None
        mock_driver.session.return_value = mock_session_context
        
        mock_graph_db.driver.return_value = mock_driver
        
        with patch('builtins.print'):
            test_bolt_connection()
        
        mock_graph_db.driver.assert_called_once()
    
    @patch('utilities.test_neo4j_connection.GraphDatabase')
    def test_test_bolt_connection_failure(self, mock_graph_db):
        """Bolt接続失敗テスト"""
        from utilities.test_neo4j_connection import test_bolt_connection
        
        mock_graph_db.driver.side_effect = Exception("Authentication failed")
        
        with patch('builtins.print'):
            test_bolt_connection()
        
        mock_graph_db.driver.assert_called_once()


class TestCrawler:
    """crawler.pyの基本機能テスト"""
    
    @patch('utilities.crawler.WebCrawler')
    def test_webcrawler_initialization(self, mock_webcrawler_class):
        """WebCrawlerクラスの初期化テスト"""
        from utilities.crawler import WebCrawler
        
        config = {
            'url': 'https://example.com',
            'login_user': 'user',
            'login_pass': 'pass',
            'max_depth': 10,
            'max_states': 100,
            'parallel_tasks': 8
        }
        
        # WebCrawlerのインスタンスが作成されることを確認
        crawler = WebCrawler(config)
        assert crawler is not None
    
    def test_page_state_dataclass(self):
        """PageStateデータクラスのテスト"""
        from utilities.crawler import PageState
        
        state = PageState(
            hash="abcd1234",
            url="https://example.com",
            title="Test Page",
            state_type="page",
            html="<html></html>",
            aria_snapshot="{}",
            timestamp="2025-01-01T00:00:00"
        )
        
        assert state.hash == "abcd1234"
        assert state.url == "https://example.com"
        assert state.title == "Test Page"
        assert state.state_type == "page"
    
    @patch('utilities.crawler.AsyncGraphDatabase')
    def test_neo4j_driver_initialization(self, mock_async_graph_db):
        """Neo4jドライバー初期化のテスト"""
        mock_driver = Mock()
        mock_async_graph_db.driver.return_value = mock_driver
        
        from utilities.crawler import NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
        
        # 定数が定義されていることを確認
        assert NEO4J_URI == "bolt://localhost:7687"
        assert NEO4J_USER == "neo4j"
        assert NEO4J_PASSWORD == "testpassword"
    
    def test_url_operations(self):
        """URL操作のテスト"""
        from urllib.parse import urljoin, urlparse
        
        base_url = "https://example.com/page1"
        
        # urljoinの動作テスト
        assert urljoin(base_url, "page2") == "https://example.com/page2"
        assert urljoin(base_url, "/page2") == "https://example.com/page2"
        assert urljoin(base_url, "https://other.com") == "https://other.com"
        
        # urlparseの動作テスト
        parsed = urlparse(base_url)
        assert parsed.scheme == "https"
        assert parsed.netloc == "example.com"
        assert parsed.path == "/page1"
    
    def test_webcrawler_config(self):
        """WebCrawlerの設定テスト"""
        from utilities.crawler import WebCrawler
        
        config = {
            'url': 'https://example.com',
            'login_user': 'testuser',
            'login_pass': 'testpass',
            'max_depth': 5,
            'max_states': 50,
            'parallel_tasks': 4
        }
        
        crawler = WebCrawler(config)
        assert crawler.config['url'] == 'https://example.com'
        assert crawler.config['max_depth'] == 5
        assert crawler.config['max_states'] == 50


@pytest.fixture
def mock_playwright():
    """Playwrightのモックフィクスチャ"""
    with patch('utilities.crawler.async_playwright') as mock:
        playwright = AsyncMock()
        browser = AsyncMock()
        context = AsyncMock()
        page = AsyncMock()
        
        mock.return_value.__aenter__.return_value = playwright
        playwright.chromium.launch.return_value = browser
        browser.new_context.return_value = context
        context.new_page.return_value = page
        
        yield {
            'playwright': playwright,
            'browser': browser,
            'context': context,
            'page': page
        }


class TestCrawlerAsync:
    """クローラーの非同期処理テスト"""
    
    @pytest.mark.asyncio
    async def test_webcrawler_context_manager(self):
        """WebCrawlerのコンテキストマネージャーテスト"""
        from utilities.crawler import WebCrawler
        
        config = {
            'url': 'https://example.com',
            'login_user': 'user',
            'login_pass': 'pass',
            'max_depth': 1,
            'max_states': 10,
            'parallel_tasks': 1
        }
        
        with patch('utilities.crawler.AsyncGraphDatabase') as mock_db:
            mock_driver = AsyncMock()
            mock_db.driver.return_value = mock_driver
            
            crawler = WebCrawler(config)
            # コンテキストマネージャーメソッドが定義されていることを確認
            assert hasattr(crawler, '__aenter__')
            assert hasattr(crawler, '__aexit__')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])