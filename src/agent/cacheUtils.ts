export type MessageBlock = { text?: string; cachePoint?: { type: string } };
export type Message = { role: 'user' | 'assistant' | 'system'; content: MessageBlock[] };

type CountsInput = { systemBlocks?: number; toolBlocks?: number };

export function addCachePoints(
  messages: Message[],
  isClaude: boolean,
  isNova: boolean,
  counts?: CountsInput,
): Message[] {
  if (!(isClaude || isNova)) return messages;

  // 深いコピー
  const messagesCloned: Message[] = JSON.parse(JSON.stringify(messages));

  // すべての既存 cachePoint を除去（messages 内）
  for (const m of messagesCloned as any[]) {
    if (!Array.isArray(m.content)) m.content = [];
    const filtered: any[] = [];
    for (const block of m.content as any[]) {
      if (block && typeof block === 'object' && 'cachePoint' in block) continue;
      filtered.push(block);
    }
    m.content = filtered;
  }

  const systemBlocks = Math.max(0, Math.trunc(Number(counts?.systemBlocks ?? 0)));
  const toolBlocks = Math.max(0, Math.trunc(Number(counts?.toolBlocks ?? 0)));
  const maxBackBlocks = 20; // Claude の簡易管理が振り返る最大コンテンツブロック境界数（約）

  function countMessageContentBlocksUpTo(endIndexInclusive: number): number {
    let sum = 0;
    for (let i = 0; i <= endIndexInclusive && i < messagesCloned.length; i += 1) {
      const c: any[] = (messagesCloned[i] as any)?.content;
      if (Array.isArray(c)) sum += c.length;
    }
    return sum;
  }

  // 直近のツールリザルト(TR)は保持し、それ以前は snapshots.text を省略
  let latestToolResultsKept = false;
  let elidedTargetIndex = -1;
  for (let i = messagesCloned.length - 1; i >= 0; i -= 1) {
    const m: any = messagesCloned[i];
    if (m?.role !== 'user') continue;
    try {
      const hasToolResult = Array.isArray(m.content) && m.content.some((c: any) => c && typeof c === 'object' && 'toolResult' in c);
      if (hasToolResult) {
        if (!latestToolResultsKept) {
          latestToolResultsKept = true; // 最新のTRは保持
        } else {
          if (elidedTargetIndex === -1) elidedTargetIndex = i; // 最も直前に省略したTR
          for (const block of m.content as any[]) {
            if (!block || !block.toolResult) continue;
            const tr = block.toolResult;
            const contents = Array.isArray(tr.content) ? tr.content : [];
            for (const cb of contents) {
              if (!cb) continue;
              // 文字列(JSON)の場合
              if (typeof cb.text === 'string') {
                try {
                  const obj = JSON.parse(cb.text);
                  if (obj && typeof obj === 'object') {
                    let changed = false;
                    if (obj.snapshots && typeof obj.snapshots === 'object') {
                      // snapshots.top[*].text を省略 / 古い実装の snapshots.text も互換削除
                      const tops = (obj.snapshots as any).top;
                      if (Array.isArray(tops)) { (obj.snapshots as any).top = tops.map(() => ({})); changed = true; }
                      if ('text' in obj.snapshots) { delete (obj as any).snapshots.text; changed = true; }
                    }
                    if ((obj as any).action === 'snapshot_search' && Array.isArray((obj as any).results)) {
                      for (const r of (obj as any).results as any[]) {
                        if (r && typeof r === 'object' && 'chunk' in r) { delete (r as any).chunk; changed = true; }
                      }
                    }
                    if (changed) cb.text = JSON.stringify(obj);
                  }
                } catch {}
                continue;
              }
              // オブジェクトの場合
              if (cb.text && typeof cb.text === 'object') {
                try {
                  const obj = cb.text as any;
                  if (obj && typeof obj === 'object') {
                    if (obj.snapshots && typeof obj.snapshots === 'object') {
                      const tops = (obj.snapshots as any).top;
                      if (Array.isArray(tops)) { (obj.snapshots as any).top = tops.map(() => ({})); }
                      if ('text' in obj.snapshots) { delete (obj as any).snapshots.text; }
                    }
                    if ((obj as any).action === 'snapshot_search' && Array.isArray((obj as any).results)) {
                      for (const r of (obj as any).results as any[]) {
                        if (r && typeof r === 'object' && 'chunk' in r) delete (r as any).chunk;
                      }
                    }
                  }
                } catch {}
              }
            }
          }
        }
      }
    } catch {}
  }

  // ターゲット選定（可動式: elided 優先 → なければ 1回目/2回目フォールバック）
  let targetIndex = -1;
  let reason = 'none';
  if (elidedTargetIndex !== -1) {
    targetIndex = elidedTargetIndex;
    reason = 'messages:elided';
  } else {
    // フォールバック: 1回目は最初の user、2回目は2番目の user
    const userIndexes: number[] = [];
    for (let i = 0; i < messagesCloned.length; i += 1) if ((messagesCloned[i] as any)?.role === 'user') userIndexes.push(i);
    const firstUserIndex = userIndexes.length >= 1 ? userIndexes[0]! : -1;
    const secondUserIndex = userIndexes.length >= 2 ? userIndexes[1]! : -1;
    if (secondUserIndex !== -1) {
      targetIndex = secondUserIndex;
      reason = 'messages:fallback:second';
    } else if (firstUserIndex !== -1) {
      targetIndex = firstUserIndex;
      reason = 'messages:fallback:first';
    }
  }

  // 付与位置の決定と追加（重複回避）
  const addedAt: string[] = [];
  const addedIndexSet = new Set<number>();

  // 可動式アンカー（常に現在の方針どおり）
  if (targetIndex !== -1) {
    const anchorMsg: any = messagesCloned[targetIndex];
    if (!Array.isArray(anchorMsg.content)) anchorMsg.content = [];
    anchorMsg.content.push({ cachePoint: { type: 'default' } });
    addedAt.push(`movable@u${targetIndex}`);
    addedIndexSet.add(targetIndex);
  }

  // 固定式アンカー（20/40/60 ... のしきい値）。可動式の位置は変えず、越えた境界の user に固定。
  function findUserCrossingIndex(threshold: number): number {
    // system+tool+messages の累積ブロックがしきい値を超える最初のメッセージ index を求め、そこから後方に最近の user を探す
    let running = systemBlocks + toolBlocks;
    for (let i = 0; i < messagesCloned.length; i += 1) {
      const c: any[] = (messagesCloned[i] as any)?.content;
      const len = Array.isArray(c) ? c.length : 0;
      running += len;
      if (running >= threshold) {
        // i から後方に最近の user を探す
        for (let j = i; j >= 0; j -= 1) {
          if ((messagesCloned[j] as any)?.role === 'user') return j;
        }
        return -1;
      }
    }
    return -1;
  }

  const thresholds: number[] = [maxBackBlocks, maxBackBlocks * 2, maxBackBlocks * 3]; // 20, 40, 60
  const maxCheckpointsPerRequest = 4; // Claude/Nova ともに 4
  const blocksUpToAnchor = targetIndex !== -1 ? countMessageContentBlocksUpTo(targetIndex) : countMessageContentBlocksUpTo(messagesCloned.length - 1);
  const totalBlocksUpToAnchor = systemBlocks + toolBlocks + blocksUpToAnchor;

  const remainingSlots = Math.max(0, maxCheckpointsPerRequest - addedIndexSet.size);
  if (remainingSlots > 0) {
    let used = 0;
    for (let k = 0; k < thresholds.length; k += 1) {
      if (used >= remainingSlots) break;
      const t = thresholds[k] ?? undefined;
      if (t === undefined) continue;
      if (totalBlocksUpToAnchor < t) break; // まだ到達していない境界
      const idx = findUserCrossingIndex(t);
      if (idx !== -1 && !addedIndexSet.has(idx)) {
        const m: any = messagesCloned[idx];
        if (!Array.isArray(m.content)) m.content = [];
        m.content.push({ cachePoint: { type: 'default' } });
        addedAt.push(`fixed@${t}:u${idx}`);
        addedIndexSet.add(idx);
        used += 1;
      }
    }
  }

  try {
    const dbg = String(process.env.AGENT_DEBUG_CACHEPOINTS ?? '').toLowerCase();
    if (dbg === '1' || dbg === 'true') {
      // eslint-disable-next-line no-console
      console.log(`[CachePoints] isClaude=${isClaude} isNova=${isNova} reason=${reason} added=${addedAt.join(',')} systemBlocks=${systemBlocks} toolBlocks=${toolBlocks}`);
    }
    const dbg2 = String(process.env.AGENT_DEBUG_ELIDE_SNAPSHOTS ?? '').toLowerCase();
    if (dbg2 === '1' || dbg2 === 'true') {
      // eslint-disable-next-line no-console
      console.log('[ElideSnapshots] 古いツールリザルトの snapshots.text を省略しました（最新のみ保持）。');
    }
  } catch {}
  return messagesCloned;
}


