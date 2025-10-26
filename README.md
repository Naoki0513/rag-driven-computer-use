# rag-driven-computer-use

> RAGで検索とコンテキスト圧縮を実現する、ブラウザ操作AIエージェント

rag-driven-computer-useは、事前にクロールしたWebサイトの構造化データ（CSV）を参照しながら、AIが自動的にブラウザ操作を実行するエージェントシステムです。従来の手法と比較して、**処理時間を約半分に短縮**し、**コストを約3分の1に削減**します。

## WebArenaベンチマーク結果

| 指標 | 従来の方法 | rag-driven-computer-use |
| --- | --- | --- |
| 処理時間 | 10.56秒 | 4.73秒 |
| コスト | $0.0264 | $0.0083 |
| 精度 | 測定中 | 測定中 |

## Playwright MCPとの比較

| 観点 | Playwright MCP | rag-driven-computer-use |
| --- | --- | --- |
| 外部データベースの利用 | × 使わない（都度検索・画面入力） | ◎ 使う（事前クロールのURL/テキスト） |
| スナップショット形式 | △ 画像+テキスト（重い/ノイズ） | ◎ テキストのみ（軽量/抽出容易） |
| スナップショット範囲 | × 画面全体 | ◎ 関連部分のみ（圧縮） |
| 対象範囲と精度 | ◎ Web全体（精度=入力依存） | △ 対象内:高精度／対象外:従来並 |
| 事前準備 | ◎ ほぼ不要 | △ 事前クロール |

### 技術スタック

- **LLM**: Claude Sonnet 4 (Amazon Bedrock)
- **Rerank**: Cohere Rerank 3.5 (Amazon Bedrock)
- **Browser**: Playwright
- **データ形式**: CSV形式の構造化データ

## Quick Start

### 1. セットアップ

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# Playwrightブラウザのインストール
npm run playwright:install
```

### 2. 環境変数の設定

プロジェクトルートに `.env` ファイルを作成します：

```bash
# AWS認証情報
AWS_PROFILE=default
# または
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# Bedrock設定
AGENT_AWS_REGION=ap-northeast-1,us-west-2
AGENT_BEDROCK_MODEL_IDS=global.example.model-id:0

# クローラ設定（任意）
CRAWLER_TARGET_URLS=https://example.com/
CRAWLER_OUTPUT_FILE=output/crawl.csv
CRAWLER_HEADFUL=false

# エージェント設定（任意）
AGENT_CSV_PATH=output/crawl.csv
AGENT_HEADFUL=false
AGENT_BEDROCK_RERANK_REGION=us-west-2
```

### 3. クローラの実行（事前クロール）

```bash
npm run start:crawler
```

出力: `output/crawl.csv`（デフォルト）

主要なCSV列: `URL`, `id`, `site`, `snapshotfor AI`, `timestamp`

**補足（クリック挙動）**
- 各ページでクリック可能要素（button / tab / menuitem）を順次クリック試行します
- link要素はクリックせず、`href`はスナップショット解析で収集します
- 重複URL・重複要素は抑制されます

### 4. エージェントの実行

```bash
# プロンプトを直接指定する場合
npm run start:agent -- --prompt "あなたの質問や命令文"

# .env の AGENT_QUERY を使用する場合
npm run start:agent
```

**優先順位**: `--prompt/-p` > 位置引数 > `.env` の `AGENT_QUERY`

### 環境変数リファレンス

#### クローラ

| 変数名 | 必須 | 説明 | デフォルト |
| --- | --- | --- | --- |
| `CRAWLER_TARGET_URLS` | 任意 | 基点URL（カンマ/空白区切り） | デモ用サイト |
| `CRAWLER_OUTPUT_FILE` | 任意 | 出力CSVパス | `output/crawl.csv` |
| `CRAWLER_HEADFUL` | 任意 | ブラウザを可視で実行 | `false` |

#### エージェント

| 変数名 | 必須 | 説明 | デフォルト |
| --- | --- | --- | --- |
| `AGENT_AWS_REGION` | 必須 | Bedrockリージョン（カンマ区切り） | - |
| `AGENT_BEDROCK_MODEL_IDS` | 必須 | モデルID | - |
| `AWS_PROFILE` | 必須* | AWS認証プロファイル | - |
| `AGENT_QUERY` | 条件付き** | クエリ（--prompt未使用時） | - |
| `AGENT_CSV_PATH` | 任意 | CSVパス | `output/crawl.csv` |
| `AGENT_HEADFUL` | 任意 | ブラウザを可視で実行 | `false` |
| `AGENT_BEDROCK_RERANK_REGION` | 任意 | Rerankリージョン | `us-west-2` |

\* `AWS_PROFILE` を使わない場合は `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` を設定
\** `--prompt` を使わない場合のみ必須

## プロジェクト構造

```
rag-driven-computer-use/
├── src/                           # メインソースコード
│   ├── agent/                    # AIエージェント
│   ├── crawler/                  # Webクローラ
│   ├── indexer/                  # インデックス作成
│   └── utilities/                # ユーティリティ
├── benchmarks/                    # 評価・ベンチマーク
│   └── webarena-shopping-admin/  # WebArena Shopping Admin ベンチマーク（41タスク）
│       ├── scripts/              # 評価スクリプト
│       ├── configs/              # タスク設定
│       ├── resources/            # クローラデータ＆インデックス
│       └── tasks/                # 実行結果
├── output/                        # 開発用一時出力
└── dist/                          # ビルド成果物
```

詳細は [benchmarks/README.md](./benchmarks/README.md) を参照してください。

## アーキテクチャ

```
クローラ → CSV → エージェント → ブラウザ操作
         ↓
     構造化データ
```

1. **クローラ**: Webサイトを事前にクロールし、ページ構造をCSV形式で保存
2. **エージェント**: CSVを参照しながら、Claude Sonnet 4とCohere Rerank 3.5を使用してブラウザ操作を実行

詳細な実装は `src/crawler/**` と `src/agent/**` を参照してください。

## ライセンス

MIT License
