#!/bin/bash
set -e

echo "========================================="
echo "WebArena Shopping Admin セットアップ"
echo "========================================="
echo ""

# 色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 変数
CONTAINER_NAME="shopping_admin"
IMAGE_NAME="shopping_admin_final_0719"
IMAGE_TAR="${IMAGE_NAME}.tar"
PORT="7780"
ADMIN_URL="http://127.0.0.1:7780"

# ダウンロード先のURL（複数のミラー）
DOWNLOAD_URLS=(
    "http://metis.lti.cs.cmu.edu/webarena-images/${IMAGE_TAR}"
    # Google Drive と Archive.org は手動ダウンロード推奨
)

# =============================================================================
# ステップ1: Dockerイメージの確認またはダウンロード
# =============================================================================
echo -e "${BLUE}ステップ1: Dockerイメージの確認${NC}"
if sudo docker images | grep -q "$IMAGE_NAME"; then
    echo -e "${GREEN}✓ Dockerイメージ '$IMAGE_NAME' が見つかりました${NC}"
else
    echo -e "${YELLOW}⚠ Dockerイメージ '$IMAGE_NAME' が見つかりません${NC}"
    echo ""
    echo "Dockerイメージをダウンロードします..."
    echo ""
    
    # ダウンロードディレクトリの作成
    DOWNLOAD_DIR="/tmp/webarena-images"
    mkdir -p "$DOWNLOAD_DIR"
    cd "$DOWNLOAD_DIR"
    
    # イメージtarファイルが既に存在するか確認
    if [ -f "$IMAGE_TAR" ]; then
        echo -e "${GREEN}✓ イメージファイル '$IMAGE_TAR' が見つかりました${NC}"
    else
        echo "イメージをダウンロード中..."
        echo ""
        echo "以下のいずれかの方法でイメージを入手してください："
        echo ""
        echo "【方法1】自動ダウンロード（CMUサーバー）"
        echo "  wget または curl を使用してダウンロードします（約4-5GB）"
        echo ""
        echo "【方法2】手動ダウンロード"
        echo "  以下のいずれかからダウンロードして、"
        echo "  $DOWNLOAD_DIR/$IMAGE_TAR に配置してください："
        echo ""
        echo "  • Google Drive:"
        echo "    https://drive.google.com/file/d/1See0ZhJRw0WTTL9y8hFlgaduwPZ_nGfd/view?usp=sharing"
        echo ""
        echo "  • Archive.org:"
        echo "    https://archive.org/download/webarena-env-shopping-admin-image"
        echo ""
        echo "  • CMU Server (自動ダウンロード可能):"
        echo "    http://metis.lti.cs.cmu.edu/webarena-images/shopping_admin_final_0719.tar"
        echo ""
        read -p "自動ダウンロードを試みますか？ (y/N): " -n 1 -r
        echo ""
        
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            DOWNLOAD_SUCCESS=false
            for url in "${DOWNLOAD_URLS[@]}"; do
                echo "ダウンロード中: $url"
                if command -v wget &> /dev/null; then
                    if wget -c "$url" -O "$IMAGE_TAR"; then
                        DOWNLOAD_SUCCESS=true
                        break
                    fi
                elif command -v curl &> /dev/null; then
                    if curl -L -C - "$url" -o "$IMAGE_TAR"; then
                        DOWNLOAD_SUCCESS=true
                        break
                    fi
                else
                    echo -e "${RED}エラー: wget または curl がインストールされていません${NC}"
                    exit 1
                fi
            done
            
            if [ "$DOWNLOAD_SUCCESS" = false ]; then
                echo -e "${RED}エラー: ダウンロードに失敗しました${NC}"
                echo "手動でダウンロードして、$DOWNLOAD_DIR/$IMAGE_TAR に配置してください"
                exit 1
            fi
        else
            echo ""
            echo "手動でダウンロードしてから、再度このスクリプトを実行してください。"
            echo "ダウンロード先: $DOWNLOAD_DIR/$IMAGE_TAR"
            exit 0
        fi
    fi
    
    # Dockerイメージのロード
    echo ""
    echo "Dockerイメージをロード中..."
    echo "※ 数分かかる場合があります（約5GB）"
    if sudo docker load --input "$IMAGE_TAR"; then
        echo -e "${GREEN}✓ Dockerイメージをロードしました${NC}"
    else
        echo -e "${RED}✗ Dockerイメージのロードに失敗しました${NC}"
        exit 1
    fi
fi
echo ""

# =============================================================================
# ステップ2: Dockerコンテナの起動
# =============================================================================
echo -e "${BLUE}ステップ2: Dockerコンテナの起動${NC}"
if sudo docker ps -a | grep -q "$CONTAINER_NAME"; then
    echo "既存のコンテナを再起動します..."
    sudo docker start "$CONTAINER_NAME"
else
    echo "新しいコンテナを作成します..."
    sudo docker run --name "$CONTAINER_NAME" -p "$PORT:80" -d "$IMAGE_NAME"
fi
echo -e "${GREEN}✓ コンテナが起動しました${NC}"
echo ""

# =============================================================================
# ステップ3: サービスの起動待機
# =============================================================================
echo -e "${BLUE}ステップ3: サービスの起動待機${NC}"
echo "  コンテナが完全に起動するまで30秒待機します..."
sleep 30
echo -e "${GREEN}✓ 待機完了${NC}"
echo ""

# =============================================================================
# ステップ4: Magento URLの設定
# =============================================================================
echo -e "${BLUE}ステップ4: Magento URLの設定${NC}"
echo "  ベースURL: $ADMIN_URL"
sudo docker exec "$CONTAINER_NAME" sh -lc "\
  /var/www/magento2/bin/magento config:set web/unsecure/base_url '${ADMIN_URL}/' --lock-env && \
  /var/www/magento2/bin/magento config:set web/secure/base_url   '${ADMIN_URL}/' --lock-env && \
  /var/www/magento2/bin/magento config:set web/unsecure/base_static_url '${ADMIN_URL}/static/' && \
  /var/www/magento2/bin/magento config:set web/secure/base_static_url   '${ADMIN_URL}/static/' && \
  /var/www/magento2/bin/magento config:set web/unsecure/base_media_url  '${ADMIN_URL}/media/'  && \
  /var/www/magento2/bin/magento config:set web/secure/base_media_url    '${ADMIN_URL}/media/'  && \
  /var/www/magento2/bin/magento config:set web/url/redirect_to_base 0 && \
  /var/www/magento2/bin/magento config:set web/cookie/cookie_domain '' && \
  echo '  静的コンテンツをデプロイ中...' && \
  php -d memory_limit=2G /var/www/magento2/bin/magento setup:static-content:deploy -f en_US >/dev/null 2>&1 && \
  echo '  キャッシュをクリア中...' && \
  /var/www/magento2/bin/magento cache:flush >/dev/null 2>&1" 2>&1 | grep -E "(Value was saved|静的コンテンツ|キャッシュ|Flushed)" || true

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Magento URLの設定が完了しました${NC}"
else
    echo -e "${YELLOW}⚠ Magento URLの設定で一部エラーが発生しましたが、継続します${NC}"
fi
echo ""

# =============================================================================
# ステップ5: 疎通確認
# =============================================================================
echo -e "${BLUE}ステップ5: サービスの疎通確認${NC}"
sleep 5  # 設定反映のため少し待機
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ADMIN_URL/" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Shopping Admin が正常に動作しています (HTTP $HTTP_CODE)${NC}"
elif [ "$HTTP_CODE" = "302" ]; then
    echo -e "${GREEN}✓ Shopping Admin が起動しています (HTTP $HTTP_CODE)${NC}"
else
    echo -e "${YELLOW}⚠ Shopping Admin の応答が想定外です (HTTP $HTTP_CODE)${NC}"
    echo "  コンテナが完全に起動するまで数分かかる場合があります"
fi
echo ""

# =============================================================================
# 完了メッセージ
# =============================================================================
echo "========================================="
echo -e "${GREEN}セットアップ完了！${NC}"
echo "========================================="
echo ""
echo "アクセス情報:"
echo "  URL:        $ADMIN_URL/admin"
echo "  ユーザー名: admin"
echo "  パスワード: admin1234"
echo ""
echo "次のステップ:"
echo "  1. ブラウザで $ADMIN_URL/admin にアクセス"
echo "  2. サービス確認: ./verify-services.sh"
echo ""
echo "データソース:"
echo "  WebArena 公式イメージ: $IMAGE_NAME"
echo "  https://github.com/web-arena-x/webarena"
echo ""
