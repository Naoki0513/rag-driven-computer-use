#!/usr/bin/env python3
"""
WebGraph-Agent: Neo4j Cypher AI エージェント
エントリポイント
"""
import sys
from agent.bedrock import run_interactive_mode

def main():
    """メイン関数"""
    if len(sys.argv) > 1 and sys.argv[1] == "--help":
        print("""
WebGraph-Agent Cypher AI エージェント

使用方法:
  python main.py

設定ファイル:
  agent/config.py: 全ての設定項目（Neo4j接続情報、AWS Bedrock設定など）

例:
  python main.py
""")
        return
    
    run_interactive_mode()

if __name__ == "__main__":
    main() 