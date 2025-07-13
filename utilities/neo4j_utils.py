from neo4j import GraphDatabase

class Neo4jManager:
    """Neo4jデータベース接続管理クラス"""
    
    def __init__(self, uri: str, user: str, password: str):
        self.driver = None
        try:
            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            # 接続テスト
            with self.driver.session() as session:
                session.run("RETURN 1")
            print(f"[OK] Neo4jに接続しました: {uri}")
        except Exception as e:
            print(f"[ERROR] Neo4j接続エラー: {str(e)}")
            raise
    
    def close(self):
        if self.driver:
            self.driver.close()
    
    def execute_cypher(self, query: str) -> list:
        """Cypherクエリを実行して結果を返す"""
        with self.driver.session() as session:
            result = session.run(query)
            return list(result) 