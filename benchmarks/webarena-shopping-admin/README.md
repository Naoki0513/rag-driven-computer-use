# WebArena Shopping Admin ベンチマーク

このディレクトリには、WebArenaのShopping Adminサイトに対する評価データと実行結果が含まれています。

## ディレクトリ構造

```
webarena-shopping-admin/
├── README.md              # このファイル
├── scripts/               # 評価スクリプト
│   └── evaluate.py       # WebArena評価スクリプト
├── configs/               # タスク設定ファイル（41個）
│   ├── 4.json
│   ├── 15.json
│   └── ...
├── resources/             # クローラデータとインデックス
│   ├── crawl.csv         # クローラ出力（78MB）
│   └── index/            # 検索インデックス
│       ├── chunks.parquet          # チャンク情報（117MB）
│       ├── vectors.faiss           # ベクトルインデックス（802MB）
│       └── vectors.faiss.mapping.json  # マッピング情報（3.4MB）
└── tasks/                 # タスク別実行結果（41個）
    ├── task_4/
    ├── task_15/
    └── ...

```

## 統計情報

- **タスク数**: 41タスク
- **クローラデータ**: 78MB
- **インデックスサイズ**: 922MB（chunks + vectors + mapping）
- **評価スクリプト**: Python（Playwright + Bedrock対応）

## タスク一覧

4, 15, 43, 65, 77, 95, 109, 115, 123, 127, 131, 157, 184, 196, 202, 211, 215, 247, 288, 348, 374, 423, 454, 458, 464, 471, 488, 491, 497, 505, 538, 548, 678, 695, 703, 704, 710, 768, 771, 773, 782

## 使い方

### 評価スクリプトの実行

```bash
cd /home/ec2-user/webarena-local/rag-driven-computer-use/benchmarks/webarena-shopping-admin

# 単一タスクの評価
python scripts/evaluate.py --config configs/4.json

# 全タスクの評価
for config in configs/*.json; do
    python scripts/evaluate.py --config "$config"
done
```

### リソースの参照

- **クローラCSV**: `resources/crawl.csv`
- **検索インデックス**: `resources/index/`

## 注意事項

- このベンチマークは**WebArena Shopping Admin**サイト専用です
- 他のWebArenaサイト（Reddit、GitLab等）は含まれていません
- 大容量ファイル（特にvectors.faiss）のため、Git管理には注意が必要です

## 関連ディレクトリ

- メインプロジェクト: `../../src/`
- 評価結果の元データ: `../../evaluations/`（廃止予定）
- 評価スクリプトの元データ: `../../scripts/`（廃止予定）

