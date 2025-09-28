# warp — Web Agent and Retrieval Pilot

[English](#english) | [日本語](#日本語)

## English

warp is an AI agent that completes browser tasks quickly, affordably, and accurately by combining search with context compression.

### How it compares
| Metric | Baseline | warp |
| --- | --- | --- |
| Time | 10.56s | 4.73s |
| Cost | $0.0264 | $0.0083 |
| Accuracy | In progress | In progress |

### Features
| Aspect | Baseline | warp |
| --- | --- | --- |
| Use of external databases | × Not used (search/type on the fly) | ◎ Used (pre-crawled URLs/text) |
| Snapshot format | △ Images + text (heavy/noisy) | ◎ Text only (lightweight/easy to extract) |
| Snapshot scope | × Entire screen | ◎ Only relevant parts (compressed) |
| Coverage and accuracy | ◎ Whole web (accuracy = input-dependent) | △ Within target: high accuracy / outside: baseline-like |
| Upfront preparation | ◎ Little to none | △ Pre-crawling |

### Why Amazon Bedrock
warp primarily uses Claude Sonnet 4 for agent reasoning and Cohere Rerank 3.5 to compress context via search. We use Amazon Bedrock because it’s the only platform that provides both models under one roof ([Claude Sonnet 4](https://www.anthropic.com/news/claude-4?ref=faangboss.com), [Cohere Rerank 3.5](https://aws.amazon.com/jp/blogs/machine-learning/cohere-rerank-3-5-is-now-available-in-amazon-bedrock-through-rerank-api/)).

### How to use (overview)
- Crawler: Pre-crawl target sites and save the site structure as structured data (CSV).
- Agent: Executes browser operations while consulting the generated CSV.

For concrete behavior and implementation details, see the scripts (`src/crawler/**`, `src/agent/**`). This guide focuses on minimal setup and how to run.

### 1) Crawler (pre-crawl → structured data)
1. Create a `.env` at the project root and set only the environment variables you need (unset values fall back to defaults).
2. Run:

Commands:

```bash
# First time only
npm install
npm run build
npm run playwright:install

# Run
npm run start:crawler
```

Output: Defaults to `output/crawl.csv` (override with `CRAWLER_OUTPUT_FILE` or `CRAWLER_CSV_PATH`).

Environment variables (.env, minimal)

- Required: none (works with the demo site and default paths even if unset)

Optional (notable)

| Variable | Example | Description |
| --- | --- | --- |
| `CRAWLER_TARGET_URLS` | `https://example.com/` | Seed URL(s). Comma/whitespace separated. Defaults to demo site when unset. |
| `CRAWLER_OUTPUT_FILE` | `output/example.csv` | Output CSV (takes precedence). Defaults to `output/crawl.csv`. |
| `CRAWLER_HEADFUL` | `false` | Run browser visible (true) / headless (false). Default `false`. |

Primary CSV columns: `URL`, `id`, `site`, `snapshotfor AI`, `timestamp` (consumed by the agent).

Important note (click behavior)

- During crawling, on each base page and base-variant page, the crawler attempts—in order—to click all clickable elements (button / tab / menuitem) extracted from the snapshot. This helps reveal state changes and discover new URLs.
- Link elements are generally not clicked; their `href` values are collected via snapshot analysis.
- Duplicate known URLs and duplicate elements are suppressed (skips known `href`s and deduplicates element signatures).

### 2) Agent (browser automation with structured data)
1. Set the required environment in `.env` (especially Bedrock settings, AWS credentials, and the CSV path).
2. Run:

Commands:

```bash
# First time only
npm install
npm run build
npm run playwright:install

# Use a prompt on the fly
npm run start:agent -- --prompt "Your question or instruction"

# Use AGENT_QUERY defined in .env (omit --prompt)
npm run start:agent
```

Environment variables (.env, minimal)

Required

| Variable | Example | Description |
| --- | --- | --- |
| `AGENT_AWS_REGION` | `ap-northeast-1,us-west-2` | Preferred order of regions to call Bedrock (comma-separated). |
| `AGENT_BEDROCK_MODEL_IDS` | `global.example.model-id:0` | Model IDs to use. If a single model, `AGENT_BEDROCK_MODEL_ID` also works. |
| `AWS_PROFILE` | `default` | AWS credentials profile for Bedrock. If not using a profile, set `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. |
| `AGENT_QUERY` (CLI omitted only) | `Please run the sample operation.` | Required when not using `--prompt`. |

Optional (notable)

| Variable | Example | Description |
| --- | --- | --- |
| `AGENT_CSV_PATH` | `output/example.csv` | Path to the CSV created by the crawler (defaults to `output/crawl.csv` when unset). |
| `AGENT_HEADFUL` | `false` | Run browser visible (true) / headless (false). Default `false`. |
| `AGENT_BEDROCK_RERANK_REGION` | `us-west-2` | Region for rerank. Defaults to `us-west-2`. |

Notes:
- CLI `--prompt`/`-p` takes precedence, then a positional argument, then `.env` `AGENT_QUERY`.
- For sites that don’t require login, you can leave `AGENT_BROWSER_USERNAME`/`AGENT_BROWSER_PASSWORD` unset (auto-login is safely skipped).

## 日本語

warpは、検索とコンテキスト圧縮でブラウザタスクを安く・速く・正確にこなすAIエージェントです。

### 従来手法との比較
| 指標 | 従来の方法 | warp |
| --- | --- | --- |
| 時間 | 10.56秒 | 4.73秒 |
| 価格 | $0.0264 | $0.0083 |
| 精度 | 測定中 | 測定中 |

### 特徴
| 観点 | 従来手法 | warp |
| --- | --- | --- |
| 外部データベースの利用 | × 使わない（都度検索・画面入力） | ◎ 使う（事前クロールのURL/テキスト） |
| スナップショット形式 | △ 画像+テキスト（重い/ノイズ） | ◎ テキストのみ（軽量/抽出容易） |
| スナップショット範囲 | × 画面全体 | ◎ 関連部分のみ（圧縮） |
| 対象範囲と精度 | ◎ Web全体（精度=入力依存） | △ 対象内:高精度／対象外:従来並 |
| 事前準備 | ◎ ほぼ不要 | △ 事前クロール |

### なぜ Amazon Bedrock なのか
warpには、AIエージェントベンチマークで高評価なClaude Sonnet 4をメインのモデルとし、さらに検索によるコンテキスト圧縮のために、Cohere rerank 3.5モデルを使用している。これらのモデルを同じプラットフォームで利用できるのはAmazon Bedrockだけであるため（[Claude Sonnet 4](https://www.anthropic.com/news/claude-4?ref=faangboss.com)、[Cohere Rerank 3.5](https://aws.amazon.com/jp/blogs/machine-learning/cohere-rerank-3-5-is-now-available-in-amazon-bedrock-through-rerank-api/)）。


### 使い方（概要）
- **クローラ**: 事前に特定サイトをクロールして、ウェブサイトの構造を構造化データ（CSV）に保存します。
- **エージェント**: 生成された構造化データ（CSV）を参照しながら、ブラウザ操作を実行します。

具体的な動作・実装の詳細は各スクリプト（`src/crawler/**`, `src/agent/**`）を参照してください。ここでは最低限の設定と実行手順のみを示します。

### 1) クローラ（事前クロール → 構造化データ化）
1. プロジェクト直下に `.env` を作成し、必要な環境変数のみ設定します（未設定はデフォルトが使われます）。
2. 実行します。

実行コマンド:

```bash
# 初回のみ
npm install
npm run build
npm run playwright:install

# 実行
npm run start:crawler
```

出力: 既定は `output/crawl.csv`（`CRAWLER_OUTPUT_FILE` または `CRAWLER_CSV_PATH` を指定すると上書き）。

環境変数（.env、最小限）

- 必須: なし（未設定でもデモ用サイトと既定パスで実行可能）

任意（主なもの）

| 変数名 | 例 | 説明 |
| --- | --- | --- |
| `CRAWLER_TARGET_URLS` | `https://example.com/` | 基点URL（カンマ/空白区切りで複数可）。未設定時はデモ用サイト。 |
| `CRAWLER_OUTPUT_FILE` | `output/example.csv` | 出力CSV（こちらが優先）。未設定時は `output/crawl.csv`。 |
| `CRAWLER_HEADFUL` | `false` | ブラウザを可視（true）/非表示（false）で実行。既定 `false`。 |

CSVの主な列: `URL`, `id`, `site`, `snapshotfor AI`, `timestamp`（エージェント側が参照します）。

重要補足（クリック挙動）

- クロール時は、各基底ページおよび基底切替ページで、スナップショットから抽出したクリック可能要素（button / tab / menuitem）を原則すべて順次クリック試行します（内部状態変化や新規URLの発見を目的）。
- link 要素は原則クリックせず、`href` はスナップショット解析で収集します。
- 既知URLの重複や同一要素の重複は抑制されます（既知`href`のスキップや要素シグネチャの重複排除）。

### 2) エージェント（構造化データを参照してブラウザ操作）
1. `.env` に必要な環境変数を設定（特に Bedrock の設定・AWS 認証情報・CSVパス）。
2. 実行します。

実行コマンド:

```bash
# 初回のみ
npm install
npm run build
npm run playwright:install

# その場のプロンプトを使う
npm run start:agent -- --prompt "あなたの質問や命令文"

# 事前に .env の AGENT_QUERY を使う（--prompt 省略）
npm run start:agent
```

環境変数（.env、最小限）

必須

| 変数名 | 例 | 説明 |
| --- | --- | --- |
| `AGENT_AWS_REGION` | `ap-northeast-1,us-west-2` | Bedrock を呼び出すリージョンの優先順（カンマ区切り）。 |
| `AGENT_BEDROCK_MODEL_IDS` | `global.example.model-id:0` | 使用するモデルID。単一なら `AGENT_BEDROCK_MODEL_ID` でも可。 |
| `AWS_PROFILE` | `default` | Bedrock 認証用の AWS 資格情報。プロファイルを使わない場合は `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` を設定。 |
| `AGENT_QUERY`（CLI省略時のみ） | `サンプルの操作を実行してください。` | `--prompt` を使わない場合に必須。 |

任意（主なもの）

| 変数名 | 例 | 説明 |
| --- | --- | --- |
| `AGENT_CSV_PATH` | `output/example.csv` | クローラで生成した CSV のパス（未設定時は `output/crawl.csv`）。 |
| `AGENT_HEADFUL` | `false` | ブラウザを可視（true）/非表示（false）。既定 `false`。 |
| `AGENT_BEDROCK_RERANK_REGION` | `us-west-2` | Rerank を行うリージョン。未設定時は `us-west-2`。 |

補足:
- `--prompt/-p` の CLI 指定が最優先、その次に位置引数、最後に `.env` の `AGENT_QUERY` が使われます。
- ログインが不要なサイトでは `AGENT_BROWSER_USERNAME/AGENT_BROWSER_PASSWORD` は未設定で問題ありません（自動ログインは安全にスキップされます）。