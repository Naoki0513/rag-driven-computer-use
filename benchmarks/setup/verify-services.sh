#!/bin/bash

echo "========================================="
echo "WebArena Shopping Admin 疎通確認"
echo "========================================="
echo ""

# 色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 変数
CONTAINER_NAME="shopping_admin"
PORT="7780"
ADMIN_URL="http://127.0.0.1:7780"

# 1. Dockerコンテナの状態確認
echo "1. Dockerコンテナの状態..."
if sudo docker ps | grep -q "$CONTAINER_NAME"; then
    STATUS=$(sudo docker ps --filter "name=$CONTAINER_NAME" --format "{{.Status}}")
    echo -e "${GREEN}✓ コンテナは実行中です${NC}"
    echo "  Status: $STATUS"
else
    echo -e "${RED}✗ コンテナが実行されていません${NC}"
    echo "  ./start-shopping-admin.sh を実行してください"
    exit 1
fi
echo ""

# 2. ポート待受確認
echo "2. ポート待受状態..."
if ss -lntp 2>/dev/null | grep -q ":$PORT "; then
    echo -e "${GREEN}✓ ポート $PORT で待受中です${NC}"
else
    echo -e "${YELLOW}⚠ ポート $PORT で待受が確認できません${NC}"
fi
echo ""

# 3. HTTP疎通確認
echo "3. HTTP疎通確認..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ADMIN_URL/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ HTTPレスポンス: $HTTP_CODE (正常)${NC}"
elif [ "$HTTP_CODE" = "302" ]; then
    echo -e "${GREEN}✓ HTTPレスポンス: $HTTP_CODE (リダイレクト - 正常)${NC}"
else
    echo -e "${YELLOW}⚠ HTTPレスポンス: $HTTP_CODE${NC}"
    echo "  コンテナが完全に起動するまで時間がかかる場合があります"
fi
echo ""

# 4. 管理画面アクセス確認
echo "4. 管理画面アクセス確認..."
ADMIN_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ADMIN_URL/admin" 2>/dev/null || echo "000")
if [ "$ADMIN_HTTP_CODE" = "200" ] || [ "$ADMIN_HTTP_CODE" = "302" ]; then
    echo -e "${GREEN}✓ 管理画面にアクセス可能です (HTTP $ADMIN_HTTP_CODE)${NC}"
else
    echo -e "${YELLOW}⚠ 管理画面のレスポンス: HTTP $ADMIN_HTTP_CODE${NC}"
fi
echo ""

# 5. URL設定確認
echo "5. URL設定確認..."
CONTENT=$(curl -sL "$ADMIN_URL/" | head -20)
if echo "$CONTENT" | grep -q "127.0.0.1:7780"; then
    echo -e "${GREEN}✓ ローカルURLで設定されています${NC}"
elif echo "$CONTENT" | grep -q "metis.lti.cs.cmu.edu"; then
    echo -e "${RED}✗ 外部URLが検出されました${NC}"
    echo "  ./start-shopping-admin.sh を再実行してください"
else
    echo -e "${YELLOW}⚠ URL設定を確認できませんでした${NC}"
fi
echo ""

# 6. 認証情報の確認
echo "6. 認証情報の確認..."
AUTH_DIR="${AUTH_DIR:-/home/ec2-user/webarena-local/.auth}"
AUTH_FILE="$AUTH_DIR/shopping_admin_state.json"

if [ -f "$AUTH_FILE" ]; then
    COOKIE_COUNT=$(python3 -c "import json; print(len(json.load(open('$AUTH_FILE')).get('cookies', [])))" 2>/dev/null || echo "0")
    if [ "$COOKIE_COUNT" -gt "0" ]; then
        echo -e "${GREEN}✓ 認証情報が存在します (cookies: $COOKIE_COUNT)${NC}"
    else
        echo -e "${YELLOW}⚠ 認証情報ファイルは存在しますが、cookieが空です${NC}"
        echo "  ./setup-auth.sh を実行してください"
    fi
else
    echo -e "${YELLOW}⚠ 認証情報ファイルが見つかりません${NC}"
    echo "  ./setup-auth.sh を実行してください"
fi
echo ""

# 完了メッセージ
echo "========================================="
echo -e "${GREEN}疎通確認が完了しました！${NC}"
echo "========================================="
echo ""
echo "サービス情報:"
echo "  管理画面URL: $ADMIN_URL/admin"
echo "  ユーザー名:  admin"
echo "  パスワード:  admin1234"
echo ""

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ]; then
    if [ -f "$AUTH_FILE" ] && [ "$COOKIE_COUNT" -gt "0" ]; then
        echo "ステータス: すべて正常です ✓"
    else
        echo "ステータス: サービスは正常ですが、認証情報が必要です"
        echo "  次のステップ: ./setup-auth.sh"
    fi
else
    echo "ステータス: 一部の確認項目で問題があります"
    echo "詳細は上記の出力を確認してください"
fi
echo ""
