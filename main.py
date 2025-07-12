#!/usr/bin/env python3
"""
WebGraph-Agent: Neo4j Cypher AI エージェント
エントリポイント
"""
import sys
import os
# Windowsのコンソールエンコーディング問題を解決
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    os.environ['PYTHONIOENCODING'] = 'utf-8'

from agent.bedrock import run_single_query

def main():
    """メイン関数"""
    if len(sys.argv) == 1 or sys.argv[1] == "--help":
        print("""
WebGraph-Agent Cypher AI エージェント

使用方法:
  python main.py "<クエリ>"

設定ファイル:
  agent/config.py: 全ての設定項目（Neo4j接続情報、AWS Bedrock設定など）

例:
  python main.py "ノード数を教えて"
  python main.py "すべてのチャンネルを表示"
  python main.py "最もリンクが多いページを5つ表示"
""")
        return
    
    # コマンドライン引数からクエリを取得
    query = " ".join(sys.argv[1:])
    run_single_query(query)

if __name__ == "__main__":
    main() 