from typing import Optional, Dict, Any
from strands.tools import tool
from utilities.neo4j_utils import Neo4jManager

# グローバルNeo4jマネージャーインスタンス（後で初期化）
neo4j_manager: Optional[Neo4jManager] = None

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