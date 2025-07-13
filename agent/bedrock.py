import sys
import boto3
from agent.config import (
    NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
    AWS_REGION, BEDROCK_MODEL_ID
)
from utilities.neo4j_utils import Neo4jManager
from agent import tools
from agent.tools import run_cypher
from agent.prompt import create_system_prompt

import copy
from typing import List, Dict, Any

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

def create_system_prompt_with_schema(database_schema: str = "") -> str:
    global _system_prompt_shown
    
    system_prompt = create_system_prompt(database_schema)
    
    if not _system_prompt_shown:
        print("\n[システムプロンプト（初回のみ表示）]")
        print("=" * 80)
        print(system_prompt)
        print("=" * 80)
        print()
        _system_prompt_shown = True
    
    return system_prompt

def add_cache_points(messages: List[Dict[str, Any]], is_claude: bool, is_nova: bool) -> List[Dict[str, Any]]:
    if not (is_claude or is_nova):
        return messages
    
    max_points = 2 if is_claude else 3 if is_nova else 0
    messages_with_cache = []
    user_turns_processed = 0
    
    for message in reversed(messages):
        m = copy.deepcopy(message)
        if m["role"] == "user" and user_turns_processed < max_points:
            append_cache = False
            if is_claude:
                append_cache = True
            elif is_nova:
                has_text = any(isinstance(c, dict) and "text" in c for c in m.get("content", []))
                if has_text:
                    append_cache = True
            if append_cache:
                if not isinstance(m["content"], list):
                    m["content"] = [{"text": m["content"]}]
                m["content"].append({"cachePoint": {"type": "default"}})
                user_turns_processed += 1
        messages_with_cache.append(m)
    
    messages_with_cache.reverse()
    return messages_with_cache

def run_single_query(query: str):
    global neo4j_manager
    
    print("WebGraph-Agent Cypher AI エージェントを起動しています...")
    
    try:
        print(f"Neo4jに接続中... URI: {NEO4J_URI}, User: {NEO4J_USER}")
        neo4j_manager = Neo4jManager(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        tools.neo4j_manager = neo4j_manager
        print("[OK] Neo4j接続に成功しました")
    except Exception as e:
        print(f"[ERROR] Neo4j接続に失敗しました: {str(e)}")
        print(f"[DEBUG] 接続情報 - URI: {NEO4J_URI}, User: {NEO4J_USER}")
        print("ヒント: Neo4jが起動していることを確認し、agent/config.pyファイルの設定を確認してください")
        import traceback
        traceback.print_exc()
        return
    
    print("データベーススキーマを取得中...")
    database_schema = get_database_schema(neo4j_manager)
    print("[OK] データベーススキーマを取得しました")
    
    try:
        system_prompt = create_system_prompt_with_schema(database_schema)
        print("[OK] AIモデルを初期化しました")
        client = boto3.client("bedrock-runtime", region_name=AWS_REGION)
    except Exception as e:
        print(f"[ERROR] エージェント初期化エラー: {str(e)}")
        print("ヒント: AWS認証情報が環境変数に正しく設定されているか確認してください")
        neo4j_manager.close()
        return
    
    print(f"\n実行中のクエリ: {query}")
    print("\nエージェント: ", end="", flush=True)
    
    # Prepare system
    system = [{"text": system_prompt}]
    lower_id = BEDROCK_MODEL_ID.lower()
    is_cache_supported = 'claude' in lower_id or 'nova' in lower_id
    is_claude = 'claude' in lower_id
    is_nova = 'nova' in lower_id
    
    if is_cache_supported:
        system.append({"cachePoint": {"type": "default"}})
    
    # Tool spec
    tool_spec = {
        "toolSpec": {
            "name": "run_cypher",
            "description": "Neo4jデータベースに対してCypherクエリを実行します",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"]
                }
            }
        }
    }
    
    tools_list = [tool_spec]
    if is_cache_supported and is_claude:
        tools_list.append({"cachePoint": {"type": "default"}})
    
    tool_config = {
        "tools": tools_list,
        "toolChoice": {"auto": {}}
    }
    
    # Initial messages
    messages = [{"role": "user", "content": [{"text": query}]}]
    
    # Token totals
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cache_write = 0
    
    full_response = ""
    
    try:
        while True:
            current_messages = add_cache_points(messages, is_claude, is_nova)
            
            response = client.converse(
                modelId=BEDROCK_MODEL_ID,
                messages=current_messages,
                system=system,
                toolConfig=tool_config
            )
            
            usage = response['usage']
            total_input += usage['inputTokens']
            total_output += usage['outputTokens']
            total_cache_read += usage.get('cacheReadInputTokens', 0)
            total_cache_write += usage.get('cacheWriteInputTokens', 0)
            
            stop_reason = response['stopReason']
            
            if stop_reason == 'end_turn':
                content = response['output']['message']['content']
                for block in content:
                    if 'text' in block:
                        full_response += block['text']
                break
            elif stop_reason == 'tool_use':
                assistant_message = {"role": "assistant", "content": response['output']['message']['content']}
                messages.append(assistant_message)
                
                tool_results = []
                for block in assistant_message['content']:
                    if 'toolUse' in block:
                        tool_use = block['toolUse']
                        tool_name = tool_use['name']
                        tool_input = tool_use['input']
                        tool_use_id = tool_use['toolUseId']
                        
                        if tool_name == 'run_cypher':
                            result = run_cypher(tool_input['query'])
                            tool_results.append({
                                "toolResult": {
                                    "toolUseId": tool_use_id,
                                    "content": [{"text": result}],
                                    "status": "success"
                                }
                            })
                
                if tool_results:
                    messages.append({"role": "user", "content": tool_results})
            else:
                print(f"\n未知のstop_reason: {stop_reason}")
                break
        
        print(full_response)
        print("\n✅ クエリ実行が完了しました")
    except Exception as e:
        print(f"\n❌ エラーが発生しました: {str(e)}")
    
    print("\nトークン使用情報:")
    print(f"- 総入力トークン数: {total_input}")
    print(f"- 総出力トークン数: {total_output}")
    print(f"- 総キャッシュ読み取りトークン数: {total_cache_read}")
    print(f"- 総キャッシュ書き込みトークン数: {total_cache_write}")
    
    if neo4j_manager:
        neo4j_manager.close()
        print("✅ Neo4j接続を閉じました")