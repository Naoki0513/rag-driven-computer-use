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