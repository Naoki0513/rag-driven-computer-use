"""
Bedrock AIエージェントのテスト
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
import sys
import os

# プロジェクトルートをPythonパスに追加
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.bedrock_agent import Neo4jManager, run_cypher, get_database_schema, create_agent


class TestNeo4jManager:
    """Neo4jManagerクラスのテスト"""
    
    @patch('agent.bedrock_agent.GraphDatabase')
    def test_init_success(self, mock_graph_db):
        """正常な接続テスト"""
        mock_driver = Mock()
        mock_session = Mock()
        mock_session.run.return_value = None
        
        # sessionのコンテキストマネージャー設定
        mock_session_context = MagicMock()
        mock_session_context.__enter__.return_value = mock_session
        mock_session_context.__exit__.return_value = None
        mock_driver.session.return_value = mock_session_context
        
        mock_graph_db.driver.return_value = mock_driver
        
        manager = Neo4jManager("bolt://localhost:7687", "neo4j", "password")
        
        assert manager.driver is not None
        mock_graph_db.driver.assert_called_once_with(
            "bolt://localhost:7687", 
            auth=("neo4j", "password")
        )
    
    @patch('agent.bedrock_agent.GraphDatabase')
    def test_init_failure(self, mock_graph_db):
        """接続失敗テスト"""
        mock_graph_db.driver.side_effect = Exception("Connection failed")
        
        with pytest.raises(Exception) as exc_info:
            Neo4jManager("bolt://localhost:7687", "neo4j", "wrong_password")
        
        assert "Connection failed" in str(exc_info.value)
    
    @patch('agent.bedrock_agent.GraphDatabase')
    def test_execute_cypher(self, mock_graph_db):
        """Cypherクエリ実行テスト"""
        mock_driver = Mock()
        mock_session = Mock()
        mock_result = [{"count": 10}]
        mock_session.run.return_value = mock_result
        
        # sessionのコンテキストマネージャー設定
        mock_session_context = MagicMock()
        mock_session_context.__enter__.return_value = mock_session
        mock_session_context.__exit__.return_value = None
        mock_driver.session.return_value = mock_session_context
        
        mock_graph_db.driver.return_value = mock_driver
        
        manager = Neo4jManager("bolt://localhost:7687", "neo4j", "password")
        result = manager.execute_cypher("MATCH (n) RETURN count(n) as count")
        
        assert result == mock_result
        mock_session.run.assert_called_with("MATCH (n) RETURN count(n) as count")


class TestToolFunctions:
    """ツール関数のテスト"""
    
    def test_run_cypher_no_connection(self):
        """Neo4j未接続時のテスト"""
        with patch('agent.bedrock_agent.neo4j_manager', None):
            result = run_cypher("MATCH (n) RETURN n")
            assert "エラー: Neo4jに接続されていません" in result
    
    @patch('agent.bedrock_agent.neo4j_manager')
    def test_run_cypher_success(self, mock_manager):
        """正常なクエリ実行テスト"""
        mock_manager.execute_cypher.return_value = [
            {"name": "Node1", "id": 1},
            {"name": "Node2", "id": 2}
        ]
        
        result = run_cypher("MATCH (n) RETURN n.name as name, n.id as id")
        
        assert "レコード 1:" in result
        assert "レコード 2:" in result
        assert "'name': 'Node1'" in result
        assert "'name': 'Node2'" in result
    
    @patch('agent.bedrock_agent.neo4j_manager')
    def test_run_cypher_empty_result(self, mock_manager):
        """空の結果のテスト"""
        mock_manager.execute_cypher.return_value = []
        
        result = run_cypher("MATCH (n:NonExistent) RETURN n")
        
        assert "結果: データが見つかりませんでした" in result
    
    @patch('agent.bedrock_agent.neo4j_manager')
    def test_run_cypher_error(self, mock_manager):
        """クエリエラーのテスト"""
        mock_manager.execute_cypher.side_effect = Exception("Invalid syntax")
        
        result = run_cypher("INVALID CYPHER QUERY")
        
        assert "クエリ実行エラー:" in result
        assert "Invalid syntax" in result
    
    @patch('agent.bedrock_agent.neo4j_manager')
    def test_get_database_schema_success(self, mock_manager):
        """スキーマ取得成功テスト"""
        mock_manager.execute_cypher.side_effect = [
            [{"label": "State"}, {"label": "Page"}],
            [{"relationshipType": "TRANSITION"}, {"relationshipType": "LINKS_TO"}],
            [{"propertyKey": "url"}, {"propertyKey": "title"}]
        ]
        
        result = get_database_schema()
        
        assert "ノードラベル: State, Page" in result
        assert "リレーションシップタイプ: TRANSITION, LINKS_TO" in result
        assert "プロパティキー（一部）: url, title" in result


class TestCreateAgent:
    """エージェント作成のテスト"""
    
    @patch('agent.bedrock_agent.BedrockModel')
    @patch('agent.bedrock_agent.Agent')
    def test_create_agent(self, mock_agent_class, mock_model_class):
        """エージェント作成テスト"""
        mock_model = Mock()
        mock_model_class.return_value = mock_model
        mock_agent = Mock()
        mock_agent_class.return_value = mock_agent
        
        result = create_agent()
        
        assert result == mock_agent
        mock_model_class.assert_called_once_with(
            model_id="anthropic.claude-3-sonnet-20240229-v1:0",
            region="us-west-2"
        )
        mock_agent_class.assert_called_once()
        
        # エージェントの設定を確認
        call_args = mock_agent_class.call_args
        assert call_args[1]['name'] == "WebGraph Cypher Agent"
        assert "Neo4jグラフデータベースの専門家" in call_args[1]['instructions']
        assert call_args[1]['model'] == mock_model
        assert len(call_args[1]['tools']) == 2


@patch('agent.bedrock_agent.input')
@patch('agent.bedrock_agent.Neo4jManager')
@patch('agent.bedrock_agent.create_agent')
def test_run_interactive_mode_quit(mock_create_agent, mock_manager_class, mock_input):
    """対話モードの終了テスト"""
    from agent.bedrock_agent import run_interactive_mode
    
    # モックの設定
    mock_manager = Mock()
    mock_manager_class.return_value = mock_manager
    mock_agent = Mock()
    mock_create_agent.return_value = mock_agent
    mock_input.side_effect = ["quit"]
    
    # 実行
    run_interactive_mode()
    
    # 検証
    mock_manager.close.assert_called_once()
    mock_agent.say.assert_called_once_with("データベースのスキーマを確認します...")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])