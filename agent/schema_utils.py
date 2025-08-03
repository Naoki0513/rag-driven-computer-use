from utilities.neo4j_utils import Neo4jManager

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
        
        # 各ノードラベルごとのプロパティキー取得
        node_props = {}
        for label in label_list:
            prop_query = f"MATCH (n:{label}) UNWIND keys(n) AS key RETURN DISTINCT key"
            props = neo4j_manager.execute_cypher(prop_query)
            node_props[label] = [record['key'] for record in props]
        
        # 各リレーションシップタイプごとのプロパティキー取得
        rel_props = {}
        for rel_type in rel_list:
            prop_query = f"MATCH ()-[r:{rel_type}]->() UNWIND keys(r) AS key RETURN DISTINCT key"
            props = neo4j_manager.execute_cypher(prop_query)
            rel_props[rel_type] = [record['key'] for record in props]
        
        # 各ノードラベルのノード数を取得
        node_counts = []
        for label in label_list:
            count_query = f"MATCH (n:{label}) RETURN count(n) as count"
            result = neo4j_manager.execute_cypher(count_query)
            if result:
                node_counts.append(f"  - {label}: {result[0]['count']}ノード (プロパティ: {', '.join(node_props.get(label, []))})")
        
        # 各リレーションシップタイプの数を取得
        rel_counts = []
        for rel_type in rel_list:
            count_query = f"MATCH ()-[r:{rel_type}]->() RETURN count(r) as count"
            result = neo4j_manager.execute_cypher(count_query)
            if result:
                rel_counts.append(f"  - {rel_type}: {result[0]['count']}件 (プロパティ: {', '.join(rel_props.get(rel_type, []))})")
        
        schema_info = f"""
データベーススキーマ情報:
- ノードラベル: {', '.join(label_list) if label_list else 'なし'}
{chr(10).join(node_counts) if node_counts else ''}

- リレーションシップタイプ: {', '.join(rel_list) if rel_list else 'なし'}
{chr(10).join(rel_counts) if rel_counts else ''}
"""
        return schema_info
        
    except Exception as e:
        return f"スキーマ取得エラー: {str(e)}" 