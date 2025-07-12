#!/usr/bin/env python3
"""
WebGraph-Agent: Neo4j Cypher AI エージェント
Strands Agents SDK + Amazon Bedrock を使用して自然言語からCypherクエリを生成・実行
"""
import os
import sys
from typing import Optional, Dict, Any
from neo4j import GraphDatabase
import boto3
from strands import Agent
from strands.models import BedrockModel
from strands.tools import tool

# 現在のディレクトリをパスに追加
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from config import (
    NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
    AWS_REGION, AWS_BEARER_TOKEN_BEDROCK, BEDROCK_MODEL_ID
)

# グローバルNeo4jマネージャーインスタンス
neo4j_manager = None


class Neo4jManager:
    """Neo4jデータベース接続管理クラス"""
    
    def __init__(self, uri: str, user: str, password: str):
        self.driver = None
        try:
            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            # 接続テスト
            with self.driver.session() as session:
                session.run("RETURN 1")
            print(f"✅ Neo4jに接続しました: {uri}")
        except Exception as e:
            print(f"❌ Neo4j接続エラー: {str(e)}")
            raise
    
    def close(self):
        if self.driver:
            self.driver.close()
    
    def execute_cypher(self, query: str) -> list:
        """Cypherクエリを実行して結果を返す"""
        with self.driver.session() as session:
            result = session.run(query)
            return list(result)


@tool(
    name="run_cypher",
    description="Neo4jデータベースに対してCypherクエリを実行します"
)
def run_cypher(query: str) -> str:
    """
    Neo4jでCypherクエリを実行
    
    Args:
        query: 実行するCypherクエリ
    
    Returns:
        クエリ実行結果の文字列表現
    """
    global neo4j_manager
    
    if not neo4j_manager:
        return "エラー: Neo4jに接続されていません"
    
    try:
        print(f"\n🔍 実行するクエリ:\n{query}\n")
        results = neo4j_manager.execute_cypher(query)
        
        if not results:
            return "結果: データが見つかりませんでした"
        
        # 結果を見やすく整形
        output = []
        for i, record in enumerate(results[:20]):  # 最大20件まで表示
            record_dict = dict(record)
            output.append(f"レコード {i+1}: {record_dict}")
        
        if len(results) > 20:
            output.append(f"\n... 他 {len(results) - 20} 件のレコードがあります")
        
        return "\n".join(output)
        
    except Exception as e:
        return f"クエリ実行エラー: {str(e)}"


@tool(
    name="get_database_schema",
    description="Neo4jデータベースのスキーマ情報を取得します"
)
def get_database_schema() -> str:
    """Neo4jデータベースのスキーマ情報を取得"""
    global neo4j_manager
    
    if not neo4j_manager:
        return "エラー: Neo4jに接続されていません"
    
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
        
        schema_info = f"""
データベーススキーマ情報:
- ノードラベル: {', '.join(label_list) if label_list else 'なし'}
- リレーションシップタイプ: {', '.join(rel_list) if rel_list else 'なし'}
- プロパティキー（一部）: {', '.join(prop_list) if prop_list else 'なし'}
"""
        return schema_info
        
    except Exception as e:
        return f"スキーマ取得エラー: {str(e)}"


def create_agent() -> Agent:
    """Bedrockモデルを使用するエージェントを作成"""
    # APIキーが設定されているか確認
    if not AWS_BEARER_TOKEN_BEDROCK or AWS_BEARER_TOKEN_BEDROCK == "your_api_key_here":
        print("⚠️  警告: AWS_BEARER_TOKEN_BEDROCKが設定されていません")
        print("💡 ヒント: agent/config.pyファイルでAPIキーを設定してください")
    
    # Strands AgentsのBedrockModelを使用
    model = BedrockModel(
        model_id=BEDROCK_MODEL_ID,
        region=AWS_REGION
    )
    
    agent = Agent(
        name="WebGraph Cypher Agent",
        system_prompt="""
あなたはNeo4jグラフデータベースの専門家です。
ユーザーの自然言語の質問を理解し、適切なCypherクエリを生成して実行します。

以下のガイドラインに従ってください：
1. まず get_database_schema ツールでスキーマを確認してください
2. ユーザーの質問に基づいて適切なCypherクエリを生成してください
3. クエリ実行後、結果を分かりやすく日本語で説明してください
4. エラーが発生した場合は、原因を説明し、修正案を提示してください

WebGraph-Agentプロジェクトには以下の種類のデータが格納されています：
- State: Webアプリケーションの状態（URL、タイトル、HTML、スナップショット等）
- TRANSITION: 状態間の遷移（クリックイベント、要素セレクタ等）
- Page: Webページ（旧simple_crawl.pyで収集）
- LINKS_TO: ページ間のリンク関係

回答は必ず日本語でお願いします。
""",
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
        print("💡 ヒント: AWS_BEARER_TOKEN_BEDROCKが正しく設定されているか確認してください")
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


def main():
    """メイン関数"""
    if len(sys.argv) > 1 and sys.argv[1] == "--help":
        print("""
WebGraph-Agent Cypher AI エージェント

使用方法:
  python agent/bedrock_agent.py

設定ファイル:
  agent/config.py: 全ての設定項目（Neo4j接続情報、AWS Bedrock設定など）

例:
  python agent/bedrock_agent.py
""")
        return
    
    run_interactive_mode()


if __name__ == "__main__":
    main()