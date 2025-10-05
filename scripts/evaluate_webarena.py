#!/usr/bin/env python3
"""
WebArena評価スクリプト（warp用ブリッジ）
・eval_types に応じて評価経路を分岐
  - string_match のみ → オフライン（Playwright不要）で評価
  - それ以外（url_match / program_html / fuzzy等を含む）→ CDP接続して既存評価器を使用
"""
import sys
import os
import json
from pathlib import Path

# WebArenaパッケージパスを通す（必要時のみ各モジュールを遅延インポート）
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'webarena'))


def _clean_answer(s: str) -> str:
    s = str(s or "").strip()
    if (s.startswith("'") and s.endswith("'")) or (s.startswith('"') and s.endswith('"')):
        s = s[1:-1]
    return s.lower()


def _eval_string_offline(trajectory: list, config: dict) -> float:
    # 末尾Actionのanswerを取得
    if not isinstance(trajectory, list) or not trajectory:
        return 0.0
    try:
        pred_raw = trajectory[-1]["answer"]
    except Exception:
        return 0.0
    pred = _clean_answer(pred_raw)

    ref_cfg = (config.get("eval") or {}).get("reference_answers") or {}
    score = 1.0
    for approach, value in ref_cfg.items():
        if approach == "exact_match":
            score *= float(_clean_answer(value) == pred)
        elif approach == "must_include":
            # value は配列想定
            if not isinstance(value, list):
                return 0.0
            for v in value:
                score *= float(_clean_answer(v) in pred)
        else:
            # それ以外（fuzzy_match 等）はここでは扱わない
            return 0.0
    return float(score)


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

    # 終了コード制御（環境変数）
    nonfatal = str(os.environ.get('AGENT_WEBARENA_NONFATAL', '')).lower() == 'true'
    try:
        score_threshold = float(str(os.environ.get('AGENT_WEBARENA_SCORE_THRESHOLD', '1.0')).strip() or '1.0')
    except Exception:
        score_threshold = 1.0
    
    # Trajectory読み込み
    with open(trajectory_file, 'r') as f:
        data = json.load(f)
    trajectory = data['trajectory']
    final_url = data.get('final_url', '')

    print(f"[評価] Trajectory長: {len(trajectory)}")

    # Configを先に読み、string_match のみならオフラインで評価
    with open(config_file, 'r') as f:
        cfg = json.load(f)
    eval_types = (cfg.get('eval') or {}).get('eval_types') or []

    only_string = isinstance(eval_types, list) and len(eval_types) == 1 and eval_types[0] == 'string_match'
    if only_string:
        score = _eval_string_offline(trajectory, cfg)
        print(f"\n{'='*60}")
        print(f"[結果] スコア: {score} (offline string_match)")
        print(f"{'='*60}\n")
        Path(result_file).parent.mkdir(parents=True, exist_ok=True)
        with open(result_file, 'w') as f:
            json.dump({
                'score': score,
                'trajectory_file': trajectory_file,
                'config_file': config_file,
                'final_url': final_url
            }, f, indent=2)
        print(f"[評価] 結果保存: {result_file}")
        # スコアに関わらず評価プロセスは成功とする（スコアはJSONで確認可能）
        if score < score_threshold:
            print(f"[情報] スコア {score} は閾値 {score_threshold} 未満ですが、評価プロセスは正常終了します")
        sys.exit(0)

    # それ以外は従来どおりCDP経由で評価
    from playwright.sync_api import sync_playwright
    from evaluation_harness.evaluators import evaluator_router

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

            Path(result_file).parent.mkdir(parents=True, exist_ok=True)
            with open(result_file, 'w') as f:
                json.dump({
                    'score': score,
                    'trajectory_file': trajectory_file,
                    'config_file': config_file,
                    'final_url': page.url
                }, f, indent=2)
            print(f"[評価] 結果保存: {result_file}")
            # スコアに関わらず評価プロセスは成功とする（スコアはJSONで確認可能）
            if score < score_threshold:
                print(f"[情報] スコア {score} は閾値 {score_threshold} 未満ですが、評価プロセスは正常終了します")
            sys.exit(0)

        except Exception as e:
            print(f"[エラー] 評価中に例外が発生: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)


if __name__ == '__main__':
    main()

