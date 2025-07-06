# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Claude Code 設定

## 基本的な応答ルール

### 言語設定
- 返答時は必ず日本語で回答すること
- システムプロンプトを使用して一貫した応答を行うこと

### 汎用的な命令の記録
- ユーザーから受けた汎用的な命令（プロジェクト固有ではない一般的な指示）は、このCLAUDE.mdファイルに記録すること
- これにより、将来的に同様の要求があった場合に一貫した対応が可能になる

## 記録された汎用的な命令

1. **日本語での応答**: 常に日本語で回答すること
2. **システムプロンプト使用**: 返答時は必ずシステムプロンプトを参照すること
3. **汎用的命令の記録**: プロジェクト固有でない一般的な指示はこのファイルに追記すること
4. **Ultrathinkの使用**: 基本的にすべてのタスクをultrathinkで実行すること
   - 複雑な問題や分析が必要な場合は必ずultrathinkを使用
   - 段階的思考が必要な場合はultrathinkで思考プロセスを明示
   - 技術的な実装や調査タスクでは特にultrathinkを活用すること

5. **WSL環境での注意点**: 
   - コマンド実行時にエラーが発生した場合は、環境の特性を理解した上でユーザーに自身の環境でのコマンド実行を促すこと
   - 作業ディレクトリ外への移動が制限されている（セキュリティ上の制約）

6. **環境制約の記録**: 
   - 新たな環境の制約や制限事項を発見した場合は、必ずCLAUDE.mdの「この環境の制約事項」セクションに追記すること
   - 制約の内容、原因、解決方法を明確に記載すること
   - プロジェクトのコマンド例も必要に応じて更新すること

## この環境の制約事項（2025年7月6日更新）

### Python実行環境
- **Python 3.12.3** がインストール済み（`python3`および`python`コマンドで実行可能）
- **pip 24.0** がインストール済み（`pip`、`pip3`、`python3 -m pip`すべて利用可能）
- **venvモジュール** が利用可能（仮想環境の作成が可能）
- **ensurepipモジュール** が利用可能（pip 24.0）
- `~/.bashrc`に`alias python=python3`を追加済み
- **python-is-python3**パッケージによりシステムレベルで`python`コマンドが`python3`にリンクされている

### インストール済みPythonパッケージ
- `python3-full 3.12.3-0ubuntu2`: 完全なPython環境（ensurepipを含む）
- `python3-pip 24.0+dfsg-1ubuntu1.2`: pipパッケージマネージャー
- `python3-venv 3.12.3-0ubuntu2`: 仮想環境作成モジュール

### 作業ディレクトリの制約
- Claude Codeのセキュリティポリシーにより、セッションの許可された作業ディレクトリ（`/mnt/c/GitHub/webgraph-demo`を含む）の子ディレクトリにのみ移動可能
- `/tmp`などのシステムディレクトリへの移動は制限されている

### 権限の制約
- sudoコマンドはパスワード入力が必要（非対話的環境では使用不可）
- システムレベルの変更はユーザー自身で実行する必要がある

### 推奨される作業方法

1. **Pythonスクリプトの実行**: `python`または`python3`コマンドのどちらでも使用可能

2. **仮想環境での作業**（推奨）:
   ```bash
   # 仮想環境の作成
   python -m venv myenv
   # 仮想環境の有効化
   source myenv/bin/activate
   # 仮想環境内でのパッケージインストール
   pip install <package-name>
   # 仮想環境の無効化
   deactivate
   ```

3. **グローバル環境へのパッケージインストール**:
   ```bash
   # ユーザー領域にインストール（推奨）
   pip install --user <package-name>
   
   # システム全体にインストール（sudoが必要）
   sudo pip install <package-name>
   ```

## Web Graph Crawler プロジェクト情報

### プロジェクト概要
Webアプリケーションの状態遷移をクロールし、ページ状態とインタラクションをNeo4jグラフデータベースに格納する高速並列クローラー。

### 環境設定
- **Neo4j接続情報**:
  - URI: `bolt://localhost:7687`
  - ユーザー名: `neo4j`
  - パスワード: `testpassword`
  - Web UI: `http://localhost:7474`

### 環境準備

#### 1. 仮想環境の作成と有効化
```bash
# 仮想環境の作成
python -m venv venv

# 仮想環境の有効化（Linux/Mac）
source venv/bin/activate

# 仮想環境の有効化（Windows）
venv\Scripts\activate
```

#### 2. 依存関係のインストール
```bash
pip install -r requirements.txt
python -m playwright install
```

#### 3. システム依存関係（Linux/WSL）
```bash
# Playwrightのブラウザー実行に必要な依存関係
sudo apt-get install libxslt1.1 libwoff1 libvpx9 libevent-2.1-7t64 \
    libopus0 libgstreamer-plugins-base1.0-0 libgstreamer-gl1.0-0 \
    libgstreamer-plugins-bad1.0-0 libwebpdemux2 libharfbuzz-icu0 \
    libenchant-2-2 libsecret-1-0 libhyphen0 libmanette-0.2-0 \
    libflite1 libgles2 gstreamer1.0-libav
```

### コマンド実行

#### Webアプリケーション状態グラフクローラー（メインスクリプト）
```bash
# 基本的な使用方法
python crawler.py --url <URL>

# すべてのオプション
python crawler.py \
    --url https://example.com \
    --user username \
    --password password \
    --depth 10 \
    --limit 1000 \
    --parallel 8 \
    --headful \
    --no-clear \
    --exhaustive

# 例: 
python crawler.py --url https://example.com --depth 5 --limit 100
```

#### オプション説明
- `--url`: クロール対象のURL（必須）
- `--user`: ログインユーザー名（オプション）
- `--password`: ログインパスワード（オプション）
- `--depth`: 最大探索深度（デフォルト: 20）
- `--limit`: 最大状態数（デフォルト: 10000）
- `--parallel`: 並列タスク数（デフォルト: 8）
- `--headful`: ブラウザを表示して実行
- `--no-clear`: 既存のデータベースをクリアしない
- `--exhaustive`: すべての状態を探索（制限を無視）

### アーキテクチャ

#### crawler.py の主要機能

1. **状態キャプチャ**
   - ページのURL、タイトル、HTML、ARIAスナップショットを保存
   - 各状態に一意のハッシュを生成

2. **インタラクション検出**
   - クリック可能な要素（ボタン、リンク、タブなど）を自動検出
   - data-qa属性、role属性、href属性などを活用

3. **並列処理**
   - 複数のブラウザーインスタンスで並列クロール
   - セマフォによる同時実行数制御

4. **認証対応**
   - ログインフォームの自動検出
   - ユーザー名/パスワードによる認証

5. **データ保存**
   - 状態をNeo4jのStateノードとして保存
   - 遷移をTRANSITIONリレーションとして保存

### Neo4jクエリ例

```cypher
# すべての状態と遷移を表示
MATCH (s1:State)-[t:TRANSITION]->(s2:State) RETURN s1,t,s2

# 状態数を確認
MATCH (s:State) RETURN count(s) as stateCount

# 遷移数を確認
MATCH ()-[t:TRANSITION]->() RETURN count(t) as transitionCount

# 特定のページタイプの状態を検索
MATCH (s:State) WHERE s.state_type = 'channel' RETURN s

# 特定URLを含む状態を検索
MATCH (s:State) WHERE s.url CONTAINS 'example' RETURN s

# 最も多く遷移先となっている状態
MATCH (s:State)<-[t:TRANSITION]-(other)
RETURN s.url, s.state_type, count(other) as inbound_transitions
ORDER BY inbound_transitions DESC
LIMIT 10

# 特定の要素セレクタによる遷移を検索
MATCH (s1:State)-[t:TRANSITION {element_selector: "[data-qa='button-submit']"}]->(s2:State)
RETURN s1, t, s2
```

### 実装上の注意点

1. **URLの正規化**: `urljoin`を使用して相対URLを絶対URLに変換
2. **内部リンクの判定**: `urlparse`でネットロケーションを比較
3. **エラーハンドリング**: クロール失敗時も処理を継続
4. **Neo4jトランザクション**: 各ページごとにノードとエッジを作成

### トラブルシューティング

- **WSL環境**: Windows環境ではブラウザアクセスに問題が発生する可能性あり
- **SPA/認証サイト**: JavaScriptで動的生成されるサイトはリンクが取得できない場合あり
- **ブラウザ接続**: `browser_fix.bat`で複数のブラウザを試行可能