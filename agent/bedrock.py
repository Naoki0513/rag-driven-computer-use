import sys
import boto3
from agent.config import (
    NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD,
    AWS_REGION, BEDROCK_MODEL_ID
)
from utilities.neo4j_utils import Neo4jManager
from agent.tools import run_cypher, execute_workflow
from agent.prompt import create_system_prompt

import copy
from typing import List, Dict, Any
import time
import botocore.exceptions
import json

from agent.cache_utils import add_cache_points
from agent.schema_utils import get_database_schema
from agent.prompt import create_system_prompt_with_schema

# グローバルNeo4jマネージャーインスタンス
neo4j_manager = None

def run_single_query(query: str):
    global neo4j_manager
    
    print("WebGraph-Agent Cypher AI エージェントを起動しています...")
    
    try:
        print(f"Neo4jに接続中... URI: {NEO4J_URI}, User: {NEO4J_USER}")
        neo4j_manager = Neo4jManager(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
        from agent import tools
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
    
    # System prompt
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

    # Add new tool
    workflow_tool = {
        "toolSpec": {
            "name": "execute_workflow",
            "description": "JSON形式のワークフローを入力として受け取り、Playwright APIを使ってブラウザを操作し、各ステップを直列に実行。目標達成したら終了。",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "workflow": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "action": {"type": "string"},
                                    "url": {"type": "string"},
                                    "name": {"type": "string"},
                                    "role": {"type": "string"},
                                    "text": {"type": "string"},
                                    "key": {"type": "string"}
                                }
                            }
                        }
                    },
                    "required": ["workflow"]
                }
            }
        }
    }

    tools_list = [tool_spec, workflow_tool]
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
            
            max_retries = 3
            retry_delay = 15  # 秒
            
            for attempt in range(max_retries + 1):
                try:
                    response = client.converse(
                        modelId=BEDROCK_MODEL_ID,
                        messages=current_messages,
                        system=system,
                        toolConfig=tool_config,
                        inferenceConfig={"maxTokens": 4096, "temperature": 0.5}
                    )
                    break
                except botocore.exceptions.ClientError as e:
                    if e.response['Error']['Code'] == 'ThrottlingException':
                        if attempt == max_retries:
                            raise
                        print(f"Throttlingエラーが発生しました。{retry_delay}秒待機してリトライします... (試行 {attempt + 1}/{max_retries + 1})")
                        time.sleep(retry_delay)
                    else:
                        # RPM/TPM関連以外のエラーはすぐに終了
                        raise
                except Exception as e:
                    # その他の例外もすぐに終了
                    raise
            
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
                            print(f"Calling tool: {tool_name} with input: {json.dumps(tool_input, ensure_ascii=False)}")
                            result = run_cypher(tool_input['query'])
                            print(f"Tool result: {result}")
                            tool_results.append({
                                "toolResult": {
                                    "toolUseId": tool_use_id,
                                    "content": [{"text": result}],
                                    "status": "success"
                                }
                            })
                        elif tool_name == 'execute_workflow':
                            print(f"Executing workflow:\n{json.dumps(tool_input['workflow'], indent=2, ensure_ascii=False)}")
                            result = execute_workflow(tool_input['workflow'])
                            print(f"Tool result: {result}")
                            tool_results.append({
                                "toolResult": {
                                    "toolUseId": tool_use_id,
                                    "content": [{"text": result}],
                                    "status": "success"
                                }
                            })
                
                if tool_results:
                    print(f"Adding tool results to messages: {json.dumps(tool_results, ensure_ascii=False)}")
                    messages.append({"role": "user", "content": tool_results})
            elif stop_reason == 'max_tokens':
                print("\n最大トークン数に達しました。応答が途切れている可能性があります。")
                break
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
    print(f"- 総トークン数: {total_input + total_output}")
    
    if neo4j_manager:
        neo4j_manager.close()
        print("✅ Neo4j接続を閉じました")