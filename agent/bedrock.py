import sys
from strands import Agent
from strands.models import BedrockModel
from agent.config import (
    NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
    AWS_REGION, BEDROCK_MODEL_ID
)
from utilities.neo4j_utils import Neo4jManager
from agent import tools
from agent.tools import run_cypher
from agent.prompt import create_system_prompt

# グローバルNeo4jマネージャーインスタンス
neo4j_manager = None

# システムプロンプトの初回表示フラグ
_system_prompt_shown = False

def get_database_schema(neo4j_manager: Neo4jManager) -> str:
    """データベースのスキーマ情報を取得"""
    try:
        # ノードラベルの取得
        labels_query = "CALL db.labels() YIELD label RETURN label"
        labels = neo4j_manager.execute_cypher(labels_query)
        label_list = [record['label'] for record in labels]
        
        # リレーションシップタイプの取得
        rel_query = "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType"
        relationships = neo4j_manager.execute_cypher(rel_query)
        rel_list = [record['relationshipType'] for record in relationships]
        
        # プロパティキーの取得
        prop_query = "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey"
        properties = neo4j_manager.execute_cypher(prop_query)
        prop_list = [record['propertyKey'] for record in properties[:20]]  # 最大20件
        
        # 各ノードラベルのノード数を取得
        node_counts = []
        for label in label_list:
            count_query = f"MATCH (n:{label}) RETURN count(n) as count"
            result = neo4j_manager.execute_cypher(count_query)
            if result:
                node_counts.append(f"  - {label}: {result[0]['count']}ノード")
        
        # 各リレーションシップタイプの数を取得
        rel_counts = []
        for rel_type in rel_list:
            count_query = f"MATCH ()-[r:{rel_type}]->() RETURN count(r) as count"
            result = neo4j_manager.execute_cypher(count_query)
            if result:
                rel_counts.append(f"  - {rel_type}: {result[0]['count']}件")
        
        schema_info = f"""
データベーススキーマ情報:
- ノードラベル: {', '.join(label_list) if label_list else 'なし'}
{chr(10).join(node_counts) if node_counts else ''}

- リレーションシップタイプ: {', '.join(rel_list) if rel_list else 'なし'}
{chr(10).join(rel_counts) if rel_counts else ''}

- プロパティキー（一部）: {', '.join(prop_list) if prop_list else 'なし'}
"""
        return schema_info
        
    except Exception as e:
        return f"スキーマ取得エラー: {str(e)}"

def create_agent(database_schema: str = "") -> Agent:
    """Bedrockモデルを使用するエージェントを作成"""
    global _system_prompt_shown
    
    # システムプロンプトを生成
    system_prompt = create_system_prompt(database_schema)
    
    # 初回のみシステムプロンプトをログ出力
    if not _system_prompt_shown:
        print("\n[システムプロンプト（初回のみ表示）]")
        print("=" * 80)
        print(system_prompt)
        print("=" * 80)
        print()
        _system_prompt_shown = True
    
    # Strands AgentsのBedrockModelを使用（AWS認証は環境変数から自動取得）
    model = BedrockModel(
        model_id=BEDROCK_MODEL_ID,
        region=AWS_REGION
    )
    
    agent = Agent(
        name="WebGraph Cypher Agent",
        system_prompt=system_prompt,
        model=model,
        tools=[run_cypher]
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
    
    # データベース構造を取得
    print("データベーススキーマを取得中...")
    database_schema = get_database_schema(neo4j_manager)
    print("[OK] データベーススキーマを取得しました")
    
    # エージェント作成
    try:
        agent = create_agent(database_schema)
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