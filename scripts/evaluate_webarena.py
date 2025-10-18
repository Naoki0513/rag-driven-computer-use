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
import time
import base64
import html
from typing import Any, List, Tuple
import subprocess

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


def _extract_pairs_from_trajectory(trajectory: list) -> Tuple[List[dict], List[dict]]:
    """Extract (states, actions) keeping order. States are dicts with 'observation' and 'info'. Actions have 'action_type'."""
    states: List[dict] = []
    actions: List[dict] = []
    for item in trajectory:
        if isinstance(item, dict) and 'observation' in item and 'info' in item:
            states.append(item)
        elif isinstance(item, dict) and 'action_type' in item:
            actions.append(item)
    # Align counts to pairs
    n = min(len(states), len(actions))
    return states[:n], actions[:n]


def _action_type_to_name(code: int) -> str:
    return {
        13: 'GOTO_URL',
        6: 'CLICK',
        7: 'TYPE',
        2: 'KEY_PRESS',
        17: 'STOP',
    }.get(int(code), f'UNKNOWN({code})')


def _default_placeholder_png_base64() -> str:
    # 1x1 transparent PNG
    return (
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    )


def _capture_screenshot_base64(page: Any) -> str:
    try:
        png_bytes = page.screenshot(full_page=False)
        return base64.b64encode(png_bytes).decode('utf-8')
    except Exception:
        return _default_placeholder_png_base64()


def _build_render_html(task_id: int, states: List[dict], actions: List[dict]) -> str:
    # Ensure same length
    n = min(len(states), len(actions))
    parts: List[str] = []
    parts.append('<!doctype html>')
    parts.append('<html><head><meta charset="utf-8"><title>WebArena Render</title></head><body>')
    parts.append(f'<h2>Rendered Result (task {task_id})</h2>')
    for i in range(n):
        st = states[i]
        ac = actions[i]
        url = str(((st.get('info') or {}).get('page') or {}).get('url') or '')
        obv = str(((st.get('observation') or {}).get('text')) or '')
        raw = str(ac.get('raw_prediction') or '')
        atype = _action_type_to_name(ac.get('action_type', -1))
        el_name = str(ac.get('element_name') or '')
        key = str(ac.get('key_comb') or '')
        goto_url = str(ac.get('url') or '')
        parsed = f"{atype} {('name='+el_name) if el_name else ''} {('key='+key) if key else ''} {('url='+goto_url) if goto_url else ''}".strip()

        parts.append(f'<h3 class="url">{html.escape(url)}</h3>')
        parts.append('<div class="state_obv"><pre>')
        parts.append(html.escape(obv))
        parts.append('</pre></div>')
        parts.append(f'<div class="raw_parsed_prediction">{html.escape(raw)}</div>')
        parts.append(f'<div class="parsed_action">{html.escape(parsed)}</div>')
        parts.append('<hr>')
    parts.append('</body></html>')
    return '\n'.join(parts)


def _build_action_history(states: List[dict], actions: List[dict]) -> List[dict]:
    n = min(len(states), len(actions))
    history: List[dict] = []
    for i in range(n):
        st = states[i]
        ac = actions[i]
        url_before = str(((st.get('info') or {}).get('page') or {}).get('url') or '')
        url_after = ''
        if i + 1 < len(states):
            nxt = states[i + 1]
            url_after = str(((nxt.get('info') or {}).get('page') or {}).get('url') or '')
        item = {
            'step': i,
            'url_before': url_before,
            'action_type': int(ac.get('action_type', -1)),
            'action': _action_type_to_name(ac.get('action_type', -1)),
            'element_name': str(ac.get('element_name') or ''),
            'element_id': str(ac.get('element_id') or ''),
            'key_comb': str(ac.get('key_comb') or ''),
            'goto_url': str(ac.get('url') or ''),
            'url_after': url_after,
            'raw_prediction': str(ac.get('raw_prediction') or ''),
        }
        history.append(item)
    return history


def _collect_pages_visited(states: List[dict], actions: List[dict]) -> List[str]:
    urls: List[str] = []
    seen = set()
    for st in states:
        u = str(((st.get('info') or {}).get('page') or {}).get('url') or '')
        if u and u not in seen:
            seen.add(u)
            urls.append(u)
    for ac in actions:
        u = str(ac.get('url') or '')
        if u and u not in seen:
            seen.add(u)
            urls.append(u)
    return urls


def _ensure_bs4_installed() -> None:
    try:
        import bs4  # noqa: F401
        return
    except Exception:
        pass
    try:
        subprocess.run([sys.executable, '-m', 'pip', 'install', 'beautifulsoup4'], check=True)
    except Exception as e:
        print(f"[警告] beautifulsoup4 の自動インストールに失敗: {e}")


def _write_merged_log(result_folder: Path, config_file: str, score: float) -> Path:
    result_folder.mkdir(parents=True, exist_ok=True)
    merged = result_folder / 'merged_log.txt'
    status = 'PASS' if float(score) == 1.0 else 'FAIL'
    with open(merged, 'w') as f:
        f.write(f"[Result] ({status}) {config_file}\n")
    return merged


def _wrap_config_for_html2json(config_file: str, out_path: Path) -> Path:
    with open(config_file, 'r') as f:
        cfg = json.load(f)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump([cfg], f, indent=2)
    return out_path


def _save_leaderboard_style_summary(
    summary_dir: Path,
    *,
    task_id: int,
    score: float,
    success: bool,
    execution_time: float,
    question: str,
    reference_answer: str,
    pipeline_answer: str,
    string_references: List[str],
    targets: List[str],
    eval_detail: dict,
    error: str,
    timestamp_iso: str,
    config_obj: dict,
    trajectory_file: str,
    run_result_folder: str,
    video_file: str,
) -> Path:
    summary_dir.mkdir(parents=True, exist_ok=True)
    ts_compact = timestamp_iso.replace(':', '-').replace('.', '-')
    out_path = summary_dir / f"{ts_compact}.json"
    payload = {
        "task_id": task_id,
        "success": bool(success),
        "score": float(score),
        "execution_time": float(execution_time),
        "question": question,
        "reference_answer": reference_answer,
        "pipeline_answer": pipeline_answer,
        "grader_reasoning": f"String evaluation: score={score}",
        "grader_extracted_result": (targets[0] if targets else pipeline_answer),
        "grader_confidence": 100.0 if success else 0.0,
        "webarena_eval_results": {
            "string_detail": {
                "references": string_references,
                "targets": targets,
                "score": float(score),
            }
        },
        "error": error,
        "timestamp": timestamp_iso,
        "task_config": config_obj,
        "citations": [],
        "action_history": [],
        "artifacts": {
            "trajectory_file": trajectory_file,
            "run_result_folder": run_result_folder,
            "video_file": video_file,
        },
    }
    with open(out_path, 'w') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    return out_path


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
    
    t0 = time.time()

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

    # 共通: states/actions抽出（HTMLレンダ生成に使用）
    states, actions = _extract_pairs_from_trajectory(trajectory)
    task_id = int(cfg.get('task_id', -1)) if isinstance(cfg.get('task_id', -1), int) else int(str(Path(config_file).stem))
    # ラン出力フォルダ（HTML等）: warp/output/webarena/runs/task_<id>_<ts>/
    ts_from_traj = Path(trajectory_file).stem.replace('task_', '')
    # 例: task_4_2025-10-13T11-31-35 → 4_2025-10-13T11-31-35
    run_dir = Path(result_file).parent.parent / 'runs' / f"task_{ts_from_traj}"

    if only_string:
        # オフライン採点
        score = _eval_string_offline(trajectory, cfg)
        # HTMLレンダ（画像なし）
        render_html = _build_render_html(task_id, states, actions)
        run_dir.mkdir(parents=True, exist_ok=True)
        render_path = run_dir / f'render_{task_id}.html'
        with open(render_path, 'w') as f:
            f.write(render_html)
        _write_merged_log(run_dir, config_file, score)

        # html2json を呼び出し
        try:
            _ensure_bs4_installed()
            from scripts.html2json import main as html2json_main
            cfg_list_path = _wrap_config_for_html2json(config_file, run_dir / 'config_for_html2json.json')
            html2json_main(str(run_dir), str(cfg_list_path))
        except Exception as e:
            print(f"[警告] html2json 変換に失敗: {e}")

        # 最終サマリー出力
        Path(result_file).parent.mkdir(parents=True, exist_ok=True)
        with open(result_file, 'w') as f:
            json.dump({
                'score': score,
                'trajectory_file': trajectory_file,
                'config_file': config_file,
                'final_url': final_url
            }, f, indent=2)
        print(f"[評価] 結果保存: {result_file}")

        # リーダーボード風サマリー
        question = str(cfg.get('intent') or '')
        ref_ans = str(((cfg.get('eval') or {}).get('reference_answer_raw_annotation')) or '')
        must_include = list(((cfg.get('eval') or {}).get('reference_answers') or {}).get('must_include') or [])
        last_stop_answer = ''
        if actions:
            # STOPは最後のアクションでない可能性もあるが、pipeline_answerには最後のactionのanswerを流用
            last_stop_answer = str(actions[-1].get('answer') or '')
        elapsed = time.time() - t0
        # 追加の詳細（操作履歴/訪問URL）
        action_history = _build_action_history(states, actions)
        pages_visited = _collect_pages_visited(states, actions)
        json_dump_file = run_dir / 'json_dump.json'
        # evaluation-result にタスク別ディレクトリを作成し、日付付きJSONを保存
        eval_task_dir = Path('/home/ec2-user/webarena-local/evaluation-result') / f'task_{task_id}'
        _save_leaderboard_style_summary(
            eval_task_dir,
            task_id=task_id,
            score=score,
            success=float(score) == 1.0,
            execution_time=elapsed,
            question=question,
            reference_answer=ref_ans,
            pipeline_answer=last_stop_answer,
            string_references=must_include,
            targets=[last_stop_answer] if last_stop_answer else [],
            eval_detail={},
            error='',
            timestamp_iso=time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime()),
            config_obj=cfg,
            trajectory_file=trajectory_file,
            run_result_folder=str(run_dir),
            video_file=str(Path(trajectory_file).with_suffix('.webm')),
        )
        # サマリーに詳細を追記
        try:
            files = sorted(list(eval_task_dir.glob('*.json')))
            if files:
                p = json.load(open(files[-1], 'r'))
                p['action_history'] = action_history
                p['pages_visited'] = pages_visited
                artifacts = p.get('artifacts', {})
                artifacts['html_render_file'] = str(render_path)
                artifacts['video_file'] = str(Path(trajectory_file).with_suffix('.webm'))
                if json_dump_file.exists():
                    artifacts['json_dump_file'] = str(json_dump_file)
                artifacts['final_url'] = final_url
                p['artifacts'] = artifacts
                with open(files[-1], 'w') as wf:
                    json.dump(p, wf, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[警告] サマリー追記中に例外: {e}")

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

            # HTMLレンダ生成
            states, actions = _extract_pairs_from_trajectory(trajectory)
            # 画像は使用しない
            render_html = _build_render_html(task_id, states, actions)
            run_dir.mkdir(parents=True, exist_ok=True)
            render_path = run_dir / f'render_{task_id}.html'
            with open(render_path, 'w') as f:
                f.write(render_html)
            _write_merged_log(run_dir, config_file, score)

            # html2json を呼び出し
            try:
                _ensure_bs4_installed()
                from scripts.html2json import main as html2json_main
                cfg_list_path = _wrap_config_for_html2json(config_file, run_dir / 'config_for_html2json.json')
                html2json_main(str(run_dir), str(cfg_list_path))
            except Exception as e:
                print(f"[警告] html2json 変換に失敗: {e}")

            # ミニ結果JSON（従来）
            Path(result_file).parent.mkdir(parents=True, exist_ok=True)
            with open(result_file, 'w') as f:
                json.dump({
                    'score': score,
                    'trajectory_file': trajectory_file,
                    'config_file': config_file,
                    'final_url': page.url
                }, f, indent=2)
            print(f"[評価] 結果保存: {result_file}")

            # リーダーボード風サマリー
            question = str(cfg.get('intent') or '')
            ref_ans = str(((cfg.get('eval') or {}).get('reference_answer_raw_annotation')) or '')
            must_include = list(((cfg.get('eval') or {}).get('reference_answers') or {}).get('must_include') or [])
            last_stop_answer = ''
            if actions:
                last_stop_answer = str(actions[-1].get('answer') or '')
            elapsed = time.time() - t0
            action_history = _build_action_history(states, actions)
            pages_visited = _collect_pages_visited(states, actions)
            json_dump_file = run_dir / 'json_dump.json'
            eval_task_dir = Path('/home/ec2-user/webarena-local/evaluation-result') / f'task_{task_id}'
            _save_leaderboard_style_summary(
                eval_task_dir,
                task_id=task_id,
                score=score,
                success=float(score) == 1.0,
                execution_time=elapsed,
                question=question,
                reference_answer=ref_ans,
                pipeline_answer=last_stop_answer,
                string_references=must_include,
                targets=[last_stop_answer] if last_stop_answer else [],
                eval_detail={},
                error='',
                timestamp_iso=time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime()),
                config_obj=cfg,
                trajectory_file=trajectory_file,
                run_result_folder=str(run_dir),
                video_file=str(Path(trajectory_file).with_suffix('.webm')),
            )
            # サマリーに詳細を追記
            try:
                files = sorted(list(eval_task_dir.glob('*.json')))
                if files:
                    p = json.load(open(files[-1], 'r'))
                    p['action_history'] = action_history
                    p['pages_visited'] = pages_visited
                    artifacts = p.get('artifacts', {})
                    artifacts['html_render_file'] = str(render_path)
                    artifacts['video_file'] = str(Path(trajectory_file).with_suffix('.webm'))
                    if json_dump_file.exists():
                        artifacts['json_dump_file'] = str(json_dump_file)
                    artifacts['final_url'] = page.url
                    p['artifacts'] = artifacts
                    with open(files[-1], 'w') as wf:
                        json.dump(p, wf, indent=2, ensure_ascii=False)
            except Exception as e:
                print(f"[警告] サマリー追記中に例外: {e}")
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

