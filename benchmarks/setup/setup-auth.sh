#!/bin/bash
set -e

echo "========================================="
echo "WebArena 認証情報セットアップ"
echo "========================================="
echo ""

# 色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 変数（環境変数で上書き可能）
WEBARENA_ROOT="${WEBARENA_ROOT:-/home/ec2-user/webarena-local}"
AUTH_DIR="${AUTH_DIR:-${WEBARENA_ROOT}/.auth}"
RENEW_AUTH_SCRIPT="${RENEW_AUTH_SCRIPT:-${WEBARENA_ROOT}/renew-auth.sh}"

# =============================================================================
# 前提条件の確認
# =============================================================================
echo -e "${BLUE}前提条件の確認${NC}"
echo "  WebArena Root: $WEBARENA_ROOT"
echo "  Auth Dir: $AUTH_DIR"
echo "  Renew Script: $RENEW_AUTH_SCRIPT"
echo ""

# renew-auth.sh スクリプトの存在確認
if [ ! -f "$RENEW_AUTH_SCRIPT" ]; then
    echo -e "${RED}✗ エラー: renew-auth.sh スクリプトが見つかりません${NC}"
    echo "  場所: $RENEW_AUTH_SCRIPT"
    echo ""
    echo "WebArenaローカル環境のセットアップが必要です。"
    echo "詳細は以下を参照してください："
    echo "  https://github.com/web-arena-x/webarena"
    echo ""
    echo "別の場所にインストールされている場合は、環境変数を設定してください："
    echo "  export WEBARENA_ROOT=/path/to/your/webarena"
    echo "  ./setup-auth.sh"
    exit 1
fi
echo -e "${GREEN}✓ renew-auth.sh スクリプトが見つかりました${NC}"

# 認証情報ディレクトリの作成
mkdir -p "$AUTH_DIR"
echo -e "${GREEN}✓ 認証情報ディレクトリ: $AUTH_DIR${NC}"
echo ""

# =============================================================================
# サービスの起動確認
# =============================================================================
echo -e "${BLUE}サービスの起動確認${NC}"

SERVICES_OK=true

# Shopping Admin (7780)
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7780/ | grep -qE "200|302"; then
    echo -e "${GREEN}✓ Shopping Admin (7780) が起動中${NC}"
else
    echo -e "${YELLOW}⚠ Shopping Admin (7780) が応答しません${NC}"
    echo "  ./start-shopping-admin.sh を実行してください"
    SERVICES_OK=false
fi

echo ""

# =============================================================================
# 認証情報の生成
# =============================================================================
echo -e "${BLUE}認証情報の生成${NC}"
echo ""

# Shopping Admin の認証情報を生成
echo "【1/1】Shopping Admin の認証情報を生成中..."
echo "  URL: http://127.0.0.1:7780/admin"
echo "  User: admin"
echo "  Pass: admin1234"
echo ""

cd "$WEBARENA_ROOT"
if bash "$RENEW_AUTH_SCRIPT" shopping_admin 2>&1 | tee /tmp/setup-auth-shopping-admin.log | tail -5; then
    if [ -f "${AUTH_DIR}/shopping_admin_state.json" ]; then
        echo -e "${GREEN}✓ Shopping Admin の認証情報を作成しました${NC}"
        echo "  ファイル: ${AUTH_DIR}/shopping_admin_state.json"
    else
        echo -e "${YELLOW}⚠ 認証情報ファイルが見つかりません${NC}"
        echo "  ログ: /tmp/setup-auth-shopping-admin.log"
    fi
else
    echo -e "${RED}✗ Shopping Admin の認証情報作成に失敗しました${NC}"
    echo "  ログ: /tmp/setup-auth-shopping-admin.log"
fi
echo ""

# =============================================================================
# その他のサービス（オプション）
# =============================================================================
echo -e "${BLUE}その他のサービスの認証情報（オプション）${NC}"
echo ""
echo "以下のサービスの認証情報も生成しますか？"
echo "  - shopping (ユーザーストア: 7770)"
echo "  - gitlab (8023)"
echo "  - reddit (9999)"
echo ""
read -p "生成しますか？ (y/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Shopping (ユーザーストア)
    if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7770/ | grep -qE "200|302"; then
        echo "【オプション】Shopping (ユーザーストア) の認証情報を生成中..."
        if bash "$RENEW_AUTH_SCRIPT" shopping; then
            echo -e "${GREEN}✓ Shopping の認証情報を作成しました${NC}"
        fi
        echo ""
    fi
    
    # GitLab
    if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8023/ | grep -qE "200|302"; then
        echo "【オプション】GitLab の認証情報を生成中..."
        if bash "$RENEW_AUTH_SCRIPT" gitlab; then
            echo -e "${GREEN}✓ GitLab の認証情報を作成しました${NC}"
        fi
        echo ""
    fi
    
    # Reddit
    if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9999/ | grep -qE "200|302"; then
        echo "【オプション】Reddit の認証情報を生成中..."
        if bash "$RENEW_AUTH_SCRIPT" reddit; then
            echo -e "${GREEN}✓ Reddit の認証情報を作成しました${NC}"
        fi
        echo ""
    fi
else
    echo "スキップしました"
    echo ""
fi

# =============================================================================
# 認証情報の検証
# =============================================================================
echo -e "${BLUE}認証情報の検証${NC}"
echo ""

AUTH_DIR="$AUTH_DIR" python3 - <<'PYEOF'
import json
import sys
import os

auth_dir = os.environ.get("AUTH_DIR")
services = ["shopping_admin", "shopping", "gitlab", "reddit"]

print("認証情報ファイルの確認:")
print("")

all_ok = True
for service in services:
    file_path = f"{auth_dir}/{service}_state.json"
    if os.path.exists(file_path):
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
                cookies = data.get("cookies", [])
                print(f"  ✓ {service:20s} {len(cookies):3d} cookies")
        except Exception as e:
            print(f"  ✗ {service:20s} エラー: {e}")
            all_ok = False
    else:
        if service == "shopping_admin":
            print(f"  ✗ {service:20s} ファイルが見つかりません (必須)")
            all_ok = False
        else:
            print(f"  - {service:20s} ファイルが見つかりません (オプション)")

print("")
sys.exit(0 if all_ok else 1)
PYEOF

VALIDATION_STATUS=$?
echo ""

# =============================================================================
# 完了メッセージ
# =============================================================================
echo "========================================="
if [ $VALIDATION_STATUS -eq 0 ]; then
    echo -e "${GREEN}認証情報のセットアップが完了しました！${NC}"
else
    echo -e "${YELLOW}認証情報のセットアップに一部問題があります${NC}"
fi
echo "========================================="
echo ""
echo "作成された認証情報:"
echo "  ディレクトリ: $AUTH_DIR"
echo ""
echo "次のステップ:"
echo "  1. サービス確認: ./verify-services.sh"
echo "  2. ベンチマーク実行: cd ../webarena-shopping-admin && python scripts/evaluate.py"
echo ""
echo "トラブルシューティング:"
echo "  - 認証エラーが発生した場合は、このスクリプトを再実行してください"
echo "  - Cookie有効期限切れ時も同様に再実行が必要です"
echo ""

