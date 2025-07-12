import sys
from strands import Agent
from strands.models import BedrockModel
from agent.config import (
    NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
    AWS_REGION, BEDROCK_MODEL_ID
)
from utilities.neo4j_utils import Neo4jManager
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

def run_interactive_mode():
    """対話モードでエージェントを実行"""
    global neo4j_manager
    
    print("🚀 WebGraph-Agent Cypher AI エージェントを起動しています...")
    
    # Neo4j接続
    try:
        neo4j_manager = Neo4jManager(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    except Exception as e:
        print(f"❌ Neo4j接続に失敗しました: {str(e)}")
        print("💡 ヒント: Neo4jが起動していることを確認し、agent/config.pyファイルの設定を確認してください")
        return
    
    # エージェント作成
    try:
        agent = create_agent()
        print("✅ AIエージェントを初期化しました")
    except Exception as e:
        print(f"❌ エージェント初期化エラー: {str(e)}")
        print("💡 ヒント: AWS認証情報が環境変数に正しく設定されているか確認してください")
        neo4j_manager.close()
        return
    
    print("\n📊 Neo4jグラフデータベースのクエリエージェントです")
    print("自然言語で質問してください（例: 「ノード数を教えて」「チャンネル一覧を表示」）")
    print("終了するには 'quit' または 'exit' と入力してください\n")
    
    # 初回スキーマ取得
    agent("データベースのスキーマを確認します...")
    
    while True:
        try:
            user_input = input("\n👤 あなた: ").strip()
            
            if user_input.lower() in ['quit', 'exit', 'q']:
                print("👋 終了します")
                break
            
            if not user_input:
                continue
            
            # エージェントに質問を送信
            print("\n🤖 エージェント: ", end="", flush=True)
            response = agent(user_input)
            
        except KeyboardInterrupt:
            print("\n\n👋 中断されました")
            break
        except Exception as e:
            print(f"\n❌ エラーが発生しました: {str(e)}")
    
    # クリーンアップ
    if neo4j_manager:
        neo4j_manager.close()
        print("✅ Neo4j接続を閉じました")