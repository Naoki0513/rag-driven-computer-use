from typing import Optional, Dict, Any
from utilities.neo4j_utils import Neo4jManager
from agent.config import BROWSER_DOMAIN, BROWSER_USERNAME, BROWSER_PASSWORD

# グローバルNeo4jマネージャーインスタンス（後で初期化）
neo4j_manager: Optional[Neo4jManager] = None

import asyncio
from playwright.async_api import async_playwright

async def execute_workflow_async(workflow):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        
        # Login if needed (assuming from config)
        await page.goto(BROWSER_DOMAIN)
        await page.wait_for_load_state('networkidle', timeout=30000)
        login_input = await page.query_selector('input[name="emailOrUsername"]')
        if login_input:
            await login_input.fill(BROWSER_USERNAME)
        password_input = await page.query_selector('input[type="password"]')
        if password_input:
            await password_input.fill(BROWSER_PASSWORD)
        submit_button = await page.query_selector('button.login')
        if submit_button:
            await submit_button.click()
        await page.wait_for_load_state('networkidle', timeout=30000)
        await page.wait_for_timeout(5000)  # Additional wait for dynamic content
        
        results = []
        snapshots = []  # To collect ARIA snapshots
        
        try:
            for i, step in enumerate(workflow):
                action = step.get('action')
                try:
                    if action == 'goto':
                        url = step.get('url')
                        if url:
                            await page.goto(url)
                            results.append(f"Navigated to {url}")
                            await page.wait_for_load_state('networkidle', timeout=30000)
                        else:
                            results.append("Invalid goto step: missing url")
                    elif action in ['click', 'input', 'press']:
                        role = step.get('role')
                        name = step.get('name')
                        if role and name:
                            locator = page.get_by_role(role, name=name, exact=True)
                            await locator.wait_for(state="visible", timeout=30000)
                            
                            if action == 'click':
                                await locator.click()
                                results.append(f"Clicked {role}: {name}")
                            elif action == 'input':
                                text = step.get('text')
                                if text:
                                    await locator.fill(text)
                                    results.append(f"Input {text} into {role}: {name}")
                            elif action == 'press':
                                key = step.get('key')
                                if key:
                                    await locator.press(key)
                                    results.append(f"Pressed {key} on {role}: {name}")
                            # Add more actions as needed
                            await page.wait_for_load_state('networkidle', timeout=30000)
                        else:
                            results.append("Invalid step: missing role or name")
                    else:
                        results.append(f"Unknown action: {action}")
                    
                    # Capture ARIA snapshot after each step
                    snapshot = await page.accessibility.snapshot()
                    snapshots.append(f"ARIA Snapshot after step {i+1}: {snapshot}")
                
                except Exception as step_error:
                    # Capture snapshot on error
                    error_snapshot = await page.accessibility.snapshot()
                    results.append(f"Error in step {i+1}: {str(step_error)}\nError ARIA Snapshot: {error_snapshot}")
                    snapshots.append(f"Error ARIA Snapshot for step {i+1}: {error_snapshot}")
                    raise  # Re-raise to handle outer try-except
            
            # Final snapshot after all steps
            final_snapshot = await page.accessibility.snapshot()
            snapshots.append(f"Final ARIA Snapshot: {final_snapshot}")
        
        except Exception as e:
            results.append(f"Workflow execution failed: {str(e)}")
        
        finally:
            await browser.close()
        
        return "\n".join(results) + "\n\nSnapshots:\n" + "\n".join(snapshots) + "\nWorkflow executed."

def execute_workflow(workflow: list[dict]) -> str:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    return loop.run_until_complete(execute_workflow_async(workflow))

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