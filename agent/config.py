"""
WebGraph-Agent Configuration
全ての設定項目をここで管理します
"""

# Neo4j設定
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"

# AWS Bedrock設定
AWS_REGION = "us-west-2"
# Inference ProfileのIDまたはARNを使用
# 利用可能なモデル: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html
BEDROCK_MODEL_ID = "us.anthropic.claude-3-7-sonnet-20250219-v1:0" 