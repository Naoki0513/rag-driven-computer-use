ローカルで GitHub Actions の E2E ワークフローを実行するには `act` を利用します。

前提:
- Docker が起動していること
- act をインストール済み（`choco install act-cli` など）

実行例:
```
act -W .github/workflows/e2e.yml -j e2e \
  -s AGENT_AWS_REGION=us-west-2 \
  -s AGENT_BEDROCK_MODEL_ID=us.anthropic.claude-3-7-sonnet-20250219-v1:0
```

補足:
- books.toscrape.com はログイン不要です。
- Playwright のブラウザバイナリはワークフロー内で自動インストールされます。

