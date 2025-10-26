# WebArena Shopping Admin セットアップガイド

このディレクトリには、WebArena Shopping Admin サイトを独自の環境でホスティング・セットアップするための手順とスクリプトが含まれています。

## 前提条件

- **OS**: Linux（推奨: Amazon Linux 2023、Ubuntu 20.04+）
- **Docker**: 20.10以降
- **Node.js**: 18以降（ベンチマーク実行時）
- **Python**: 3.11以降（ベンチマーク実行時）
- **空きポート**: 7780

### 環境変数（オプション）

デフォルトのパスをカスタマイズする場合は、以下の環境変数を設定できます：

- `WEBARENA_ROOT`: WebArenaローカル環境のルートディレクトリ（デフォルト: `/home/ec2-user/webarena-local`）
- `AUTH_DIR`: 認証情報ファイルの保存先（デフォルト: `${WEBARENA_ROOT}/.auth`）
- `RENEW_AUTH_SCRIPT`: 認証スクリプトのパス（デフォルト: `${WEBARENA_ROOT}/renew-auth.sh`）

**使用例**:
```bash
export WEBARENA_ROOT="/path/to/your/webarena"
./setup-auth.sh
```

### Dockerイメージの入手

WebArena Shopping Admin のDockerイメージ（`shopping_admin_final_0719`）が必要です。

**自動セットアップ**: `start-shopping-admin.sh` を実行すると、イメージが存在しない場合は自動的にダウンロードします。

**手動ダウンロード**: 以下のいずれかからダウンロードできます（約4-5GB）：

- **Google Drive**: https://drive.google.com/file/d/1See0ZhJRw0WTTL9y8hFlgaduwPZ_nGfd/view?usp=sharing
- **Archive.org**: https://archive.org/download/webarena-env-shopping-admin-image
- **CMU Server**: http://metis.lti.cs.cmu.edu/webarena-images/shopping_admin_final_0719.tar

ダウンロード後：
```bash
# イメージをDockerにロード
docker load --input shopping_admin_final_0719.tar

# 確認
docker images | grep shopping_admin
```

## クイックスタート

### 1. リポジトリのクローン

```bash
git clone <your-repo-url>
cd rag-driven-computer-use
```

### 2. 依存関係のインストール

```bash
# Node.js依存関係
npm install

# Playwrightブラウザ
npm run playwright:install
```

### 3. Shopping Admin の起動

```bash
cd benchmarks/setup
./start-shopping-admin.sh
```

このスクリプトは以下を自動的に実行します：
1. **Dockerイメージの確認**（なければダウンロードを案内）
2. Dockerイメージのロード（tarファイルが存在する場合）
3. Dockerコンテナの起動
4. コンテナの完全起動まで待機（30秒）
5. Magento URL設定（ローカルホスト向け）
6. 静的コンテンツのデプロイ
7. キャッシュのクリア
8. 疎通確認

**重要**: 
- 初回実行時はDockerイメージのダウンロードが必要です（約4-5GB）
- 外部URL（`http://metis.lti.cs.cmu.edu:7780/`）へのリダイレクトを防ぎます

### ワンライナーセットアップ（全自動）

すべてのステップを一度に実行する場合：

```bash
cd benchmarks/setup && \
./start-shopping-admin.sh && \
./setup-auth.sh && \
./verify-services.sh
```

### 4. 認証情報（storageState）の作成

Playwright経由でのログイン状態を保存するためのstorageStateファイルを作成します。

```bash
./setup-auth.sh
```

このスクリプトは以下を自動的に実行します：
1. Shopping Admin の認証情報を生成（`.auth/shopping_admin_state.json`）
2. その他のサービスの認証情報も生成可能（shopping、gitlab、reddit）
3. 認証情報の検証

**重要**:
- 認証情報はCookie有効期限切れやセッション失効時に再生成が必要です
- ベンチマーク実行時にログインエラーが発生した場合は、このスクリプトを再実行してください

### 5. 疎通確認

```bash
./verify-services.sh
```

### 6. ブラウザでアクセス

- **URL**: http://127.0.0.1:7780/admin
- **ユーザー名**: admin
- **パスワード**: admin1234

## ファイル構成

```
benchmarks/setup/
├── README.md                  # このファイル
├── start-shopping-admin.sh    # Shopping Admin起動スクリプト
├── setup-auth.sh              # 認証情報（storageState）作成スクリプト
└── verify-services.sh         # サービス疎通確認スクリプト
```

### スクリプト詳細

#### `start-shopping-admin.sh`
- **目的**: Shopping Admin コンテナの起動とURL設定
- **実行タイミング**: 初回セットアップ時、再起動後
- **処理内容**:
  - Dockerイメージのダウンロード・ロード
  - コンテナの起動/再起動
  - Magento URL設定（ローカルホスト）
  - 静的コンテンツのデプロイ
  - キャッシュのクリア

#### `setup-auth.sh`
- **目的**: Playwright用の認証情報（storageState）の作成
- **実行タイミング**: 初回セットアップ時、Cookie期限切れ時
- **処理内容**:
  - Shopping Admin の認証情報作成（必須）
  - その他サービスの認証情報作成（オプション）
  - 認証情報の検証
- **依存**: `/home/ec2-user/webarena-local/renew-auth.sh`

#### `verify-services.sh`
- **目的**: サービスと認証情報の疎通確認
- **実行タイミング**: セットアップ後、トラブルシューティング時
- **確認内容**:
  - Dockerコンテナの実行状態
  - ポート待受状態
  - HTTP疎通
  - URL設定
  - 認証情報の存在

## ベンチマークの実行

セットアップが完了したら、ベンチマークを実行できます。

**前提条件**:
- Shopping Admin が起動していること（`./start-shopping-admin.sh`）
- 認証情報が作成されていること（`./setup-auth.sh`）

**実行方法**:
```bash
cd ../webarena-shopping-admin
python scripts/evaluate.py --config configs/4.json
```

**注意**:
- 初回実行時やログインエラーが発生した場合は、`./setup-auth.sh` で認証情報を再生成してください

## トラブルシューティング

### 外部URLにリダイレクトされる

**症状**: `http://metis.lti.cs.cmu.edu:7780/` にリダイレクトされる

**解決方法**:
```bash
./start-shopping-admin.sh
```
起動スクリプトを再実行すると、URL設定が再適用されます。

### コンテナが起動しない

**原因**: ポート7780が既に使用されている

**解決方法**:
```bash
# ポート占有プロセスの確認
sudo lsof -i :7780

# 既存コンテナを停止
sudo docker stop shopping_admin
sudo docker rm shopping_admin

# 再起動
./start-shopping-admin.sh
```

### Docker イメージがない

**原因**: `shopping_admin_final_0719` イメージがダウンロード・ロードされていない

**解決方法**:

**方法1（推奨）**: スクリプトを実行すると自動的にダウンロードを案内します
```bash
./start-shopping-admin.sh
```

**方法2**: 手動でダウンロード
1. 以下のいずれかからダウンロード（約4-5GB）：
   - Google Drive: https://drive.google.com/file/d/1See0ZhJRw0WTTL9y8hFlgaduwPZ_nGfd/view?usp=sharing
   - Archive.org: https://archive.org/download/webarena-env-shopping-admin-image
   - CMU: http://metis.lti.cs.cmu.edu/webarena-images/shopping_admin_final_0719.tar
2. ダウンロードしたファイルをロード：
   ```bash
   docker load --input shopping_admin_final_0719.tar
   ```

### 静的ファイルが表示されない

**症状**: テキストのみ表示される、スタイルが適用されない

**解決方法**:
```bash
./start-shopping-admin.sh
```
起動スクリプトが静的コンテンツを自動的にデプロイします。

### ベンチマーク実行時にログインエラーが発生する

**症状**: "Login failed" や "Authentication required" エラーが表示される

**原因**: Cookie有効期限切れ、セッション失効

**解決方法**:
```bash
./setup-auth.sh
```
認証情報を再生成してから、ベンチマークを再実行してください。

### 認証情報ファイルが見つからない

**症状**: `.auth/shopping_admin_state.json` が存在しない

**解決方法**:
```bash
./setup-auth.sh
```
初回セットアップ時は必ず認証情報を作成する必要があります。

## 関連リソース

- [WebArena 公式リポジトリ](https://github.com/web-arena-x/webarena)
- [Magento ドキュメント](https://devdocs.magento.com/)
- [プロジェクトREADME](../../README.md)

## サポート

問題が解決しない場合は、以下の情報と共にIssueを作成してください：

1. OSとバージョン
2. Dockerバージョン（`docker --version`）
3. エラーメッセージ
4. `sudo docker logs shopping_admin` の出力（最後の50行）
