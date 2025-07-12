import sys
from strands import Agent
from strands.models import BedrockModel
from agent.config import (
    NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
    AWS_REGION, BEDROCK_MODEL_ID
)
from utilities.neo4j_utils import Neo4jManager
from agent import tools
from agent.tools import run_cypher, get_database_schema
from agent.prompt import SYSTEM_PROMPT

# グローバルNeo4jマネージャーインスタンス
neo4j_manager = None

def create_agent() -> Agent:
    """Bedrockモデルを使用するエージェントを作成"""
    # Strands AgentsのBedrockModelを使用（AWS認証は環境変数から自動取得）
    model = BedrockModel(
        model_id=BEDROCK_MODEL_ID,
        region=AWS_REGION
    )
    
    agent = Agent(
        name="WebGraph Cypher Agent",
        system_prompt=SYSTEM_PROMPT,
        model=model,
        tools=[run_cypher, get_database_schema]
    )
    
    return agent

def run_single_query(query: str):
    """単一のクエリを実行して結果を返す"""
    global neo4j_manager
    
    print("WebGraph-Agent Cypher AI エージェントを起動しています...")
    
    # Neo4j接続
    try:
        print(f"Neo4jに接続中... URI: {NEO4J_URI}, User: {NEO4J_USER}")
        neo4j_manager = Neo4jManager(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        # toolsモジュールのneo4j_managerも更新
        tools.neo4j_manager = neo4j_manager
        print("[OK] Neo4j接続に成功しました")
    except Exception as e:
        print(f"[ERROR] Neo4j接続に失敗しました: {str(e)}")
        print(f"[DEBUG] 接続情報 - URI: {NEO4J_URI}, User: {NEO4J_USER}")
        print("ヒント: Neo4jが起動していることを確認し、agent/config.pyファイルの設定を確認してください")
        import traceback
        traceback.print_exc()
        return
    
    # エージェント作成
    try:
        agent = create_agent()
        print("[OK] AIエージェントを初期化しました")
    except Exception as e:
        print(f"[ERROR] エージェント初期化エラー: {str(e)}")
        print("ヒント: AWS認証情報が環境変数に正しく設定されているか確認してください")
        neo4j_manager.close()
        return
    
    print(f"\n実行中のクエリ: {query}")
    print("\nエージェント: ", end="", flush=True)
    
    try:
        # エージェントにクエリを送信
        response = agent(query)
        print("\n✅ クエリ実行が完了しました")
    except Exception as e:
        print(f"\n❌ エラーが発生しました: {str(e)}")
    
    # クリーンアップ
    if neo4j_manager:
        neo4j_manager.close()
        print("✅ Neo4j接続を閉じました")