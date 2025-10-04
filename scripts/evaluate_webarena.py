#!/usr/bin/env python3
"""
WebArena評価スクリプト（warp用ブリッジ）
warpが生成したtrajectory.jsonとCDP Endpointを使い、WebArenaの評価器でスコア算出
"""
import sys
import json
from pathlib import Path

# WebArenaモジュールをインポート（既存のパッケージを再利用）
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'webarena'))

from playwright.sync_api import sync_playwright
from evaluation_harness import evaluator_router
from browser_env.helper_functions import PseudoPage


def main():
    if len(sys.argv) < 4:
        print("Usage: evaluate_webarena.py <trajectory.json> <config_file> <cdp_endpoint> [result_file]")
        sys.exit(1)
    
    trajectory_file = sys.argv[1]
    config_file = sys.argv[2]
    cdp_endpoint = sys.argv[3]
    result_file = sys.argv[4] if len(sys.argv) > 4 else str(Path(trajectory_file).parent.parent / 'results' / f'{Path(trajectory_file).stem}_result.json')
    
    print(f"[評価] trajectory: {trajectory_file}")
    print(f"[評価] config: {config_file}")
    print(f"[評価] CDP: {cdp_endpoint}")
    
    # Trajectory読み込み
    with open(trajectory_file, 'r') as f:
        data = json.load(f)
    trajectory = data['trajectory']
    final_url = data.get('final_url', '')
    
    print(f"[評価] Trajectory長: {len(trajectory)}")
    
    # CDP経由でブラウザに再接続
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(cdp_endpoint)
            contexts = browser.contexts
            if not contexts:
                print("[エラー] ブラウザコンテキストが見つかりません")
                sys.exit(1)
            
            context = contexts[0]
            pages = context.pages
            if not pages:
                print("[エラー] ページが見つかりません")
                sys.exit(1)
            
            page = pages[0]
            
            # CDPセッション作成
            client = page.context.new_cdp_session(page)
            
            print(f"[評価] ブラウザ再接続成功: {page.url}")
            
            # WebArenaの評価器で評価
            evaluator = evaluator_router(config_file)
            score = evaluator(
                trajectory=trajectory,
                config_file=config_file,
                page=page,
                client=client
            )
            
            print(f"\n{'='*60}")
            print(f"[結果] スコア: {score}")
            print(f"{'='*60}\n")
            
            # 結果保存
            Path(result_file).parent.mkdir(parents=True, exist_ok=True)
            with open(result_file, 'w') as f:
                json.dump({
                    'score': score,
                    'trajectory_file': trajectory_file,
                    'config_file': config_file,
                    'final_url': page.url
                }, f, indent=2)
            print(f"[評価] 結果保存: {result_file}")
            
            sys.exit(0 if score == 1.0 else 1)
            
        except Exception as e:
            print(f"[エラー] 評価中に例外が発生: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)


if __name__ == '__main__':
    main()

