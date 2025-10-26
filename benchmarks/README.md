# Benchmarks

このディレクトリには、rag-driven-computer-useプロジェクトの評価・ベンチマーク関連ファイルが含まれています。

## ディレクトリ構造

```
benchmarks/
├── README.md                      # このファイル
├── setup/                         # WebArena Shopping Admin セットアップスクリプト
│   ├── README.md                  # セットアップガイド
│   ├── start-shopping-admin.sh    # Dockerコンテナ起動 + URL設定
│   └── verify-services.sh         # サービス疎通確認
└── webarena-shopping-admin/       # WebArena Shopping Admin ベンチマーク
    ├── scripts/                   # 評価スクリプト
    ├── configs/                   # タスク設定ファイル（41個）
    ├── resources/                 # クローラデータとインデックス（1GB）
    └── tasks/                     # タスク別実行結果（41個）
```

## セットアップ

WebArena Shopping Admin ベンチマークを実行する前に、環境のセットアップが必要です。

### クイックスタート

```bash
cd benchmarks/setup

# 1. Shopping Admin を起動
./start-shopping-admin.sh

# 2. サービスの疎通確認
./verify-services.sh

# 3. ブラウザでアクセス
# → http://127.0.0.1:7780/admin
# → ユーザー名: admin / パスワード: admin1234
```

**詳細**: [setup/README.md](./setup/README.md)

## 現在のベンチマーク

### WebArena Shopping Admin

- **サイト**: WebArena Shopping Admin
- **タスク数**: 41
- **リソースサイズ**: 約1GB（Git管理外、[Google Driveからダウンロード](https://drive.google.com/file/d/1pSuZCAlXptybtUL43LEZBZnjtrmrXFD4/view?usp=sharing)）
- **詳細**: [webarena-shopping-admin/README.md](./webarena-shopping-admin/README.md)

## 今後の拡張予定

このディレクトリ構造は、将来的に他のベンチマークを追加できるよう設計されています：

- `webarena-reddit/` - WebArena Reddit サイト
- `webarena-gitlab/` - WebArena GitLab サイト
- `webarena-wikipedia/` - WebArena Wikipedia サイト
- `webarena-map/` - WebArena Map サイト
- `custom-benchmarks/` - カスタムベンチマーク

## 設計方針

1. **メインコードとの分離**: `src/`ディレクトリとは完全に分離
2. **自己完結性**: 各ベンチマークは独立して実行可能
3. **再現性**: クローラデータ、インデックス、設定、結果をすべて保存
4. **拡張性**: 新しいベンチマークを簡単に追加可能

## 関連ドキュメント

- プロジェクト概要: [../README.md](../README.md)
- メインソースコード: [../src/](../src/)

