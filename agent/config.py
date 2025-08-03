"""
WebGraph-Agent Configuration
全ての設定項目をここで管理します
"""

NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = "testpassword"
AWS_REGION = "us-west-2"
BEDROCK_MODEL_ID = "us.anthropic.claude-3-7-sonnet-20250219-v1:0"

# Browser settings for execute_workflow tool
BROWSER_DOMAIN = "http://the-agent-company.com:3000/"  # Target domain, adjust as needed
BROWSER_USERNAME = "theagentcompany"  # Login username
BROWSER_PASSWORD = "theagentcompany"  # Login password 