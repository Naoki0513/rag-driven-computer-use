# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 基本的な応答ルール

1. **日本語での応答**: 常に日本語で回答すること
2. **Ultrathinkの使用**: 基本的にすべてのタスクをultrathinkで実行すること
3. **Python仮想環境**: 必ずRust製の「uv」を使用すること
4. **環境制約の記録**: 新たな制約を発見した場合は、このファイルの「環境の制約事項」セクションに追記すること

## 環境の制約事項（2025年1月更新）

### Windows PowerShell環境
- **実行環境**: Windows PowerShell
- **パス指定**: 常にWindowsスタイル（C:\形式）で使用
- **作業ディレクトリ**: Claude Codeのセキュリティポリシーにより、`C:\GitHub\webgraph-demo`の子ディレクトリのみアクセス可能
- **権限**: 管理者権限が必要な操作は、PowerShellを管理者として実行する必要がある

### Python環境
- **Python**: `python`または`py`コマンドで実行可能
- **仮想環境**: `.uv_venv`（構築済み）
- **有効化**: `.uv_venv\Scripts\activate`（PowerShell）または`.uv_venv\Scripts\activate.bat`（コマンドプロンプト）

## Web Graph Crawler プロジェクト

### プロジェクト概要
Webアプリケーションの状態遷移をクロールし、ページ状態とインタラクションをNeo4jグラフデータベースに格納する高速並列クローラー。

### Neo4j接続情報
- URI: `bolt://localhost:7687`
- ユーザー名: `neo4j`
- パスワード: `testpassword`
- Web UI: `http://localhost:7474`

### 主要コンポーネント

#### 1. utilities\crawler.py
メインのクローラースクリプト。Webアプリケーションの状態遷移を探索。

```powershell
# 仮想環境を有効化してから実行
.uv_venv\Scripts\activate

# 基本実行
python utilities\crawler.py --url https://example.com

# オプション付き実行
python utilities\crawler.py --url https://example.com --depth 5 --limit 100 --parallel 8
```

**主要オプション**:
- `--url`: クロール対象URL（必須）
- `--user/--password`: 認証情報
- `--depth`: 探索深度（デフォルト: 20）
- `--limit`: 最大状態数（デフォルト: 10000）
- `--parallel`: 並列タスク数（デフォルト: 8）
- `--headful`: ブラウザ表示モード
- `--no-clear`: 既存データを保持

#### 2. agent\bedrock.py
Amazon Bedrockを使用した自然言語からCypherクエリを生成するAIエージェント。

環境変数設定（.envファイルまたはPowerShell）:
```powershell
$env:AWS_REGION = "us-west-2"
```

### インストール済みパッケージ（requirements.txt）
- neo4j>=5.24.0
- python-dotenv>=1.0.1
- pytest>=8.2.0
- pytest-asyncio>=0.21.0
- playwright==1.47.0
- requests>=2.31.0
- boto3>=1.39.3

### トラブルシューティング

1. **Windows Defenderによるブロック**: ブラウザー起動時に発生する場合は除外設定を追加
2. **PowerShell実行ポリシー**: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
3. **Playwr
ightクラッシュ**: `python -m playwright install --force`で再インストール

### Neo4jクエリ例

```cypher
# すべての状態と遷移を表示
MATCH (s1:State)-[t:TRANSITION]->(s2:State) RETURN s1,t,s2

# 状態数を確認
MATCH (s:State) RETURN count(s) as stateCount

# 特定URLを含む状態を検索
MATCH (s:State) WHERE s.url CONTAINS 'example' RETURN s
```