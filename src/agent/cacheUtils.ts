export type MessageBlock = { text?: string; cachePoint?: { type: string } };
export type Message = { role: 'user' | 'assistant' | 'system'; content: MessageBlock[] };

export function addCachePoints(
  messages: Message[],
  isClaude: boolean,
  isNova: boolean,
): Message[] {
  if (!(isClaude || isNova)) return messages;

  const maxPoints = isClaude ? 2 : isNova ? 3 : 0;
  const messagesWithCache: Message[] = [];
  let userTurnsProcessed = 0;
  // Claude 向けの遅延: user メッセージが2件以上ある場合は最新の1件をスキップ
  const totalUserMessages = messages.reduce((acc, m) => acc + (m.role === 'user' ? 1 : 0), 0);
  const shouldSkipNewestUserOnce = isClaude && totalUserMessages >= 2;
  let newestUserSkipped = false;
  const cachedKinds: string[] = [];

  for (const message of [...messages].reverse()) {
    const m: Message = JSON.parse(JSON.stringify(message));
    if (m.role === 'user') {
      if (shouldSkipNewestUserOnce && !newestUserSkipped) {
        newestUserSkipped = true;
        messagesWithCache.push(m);
        continue;
      }
      if (userTurnsProcessed < maxPoints) {
        let appendCache = false;
        if (isClaude) appendCache = true;
        else if (isNova) {
          const hasText = Array.isArray(m.content) && m.content.some((c) => typeof c === 'object' && 'text' in c);
          if (hasText) appendCache = true;
        }
        if (appendCache) {
          if (!Array.isArray(m.content)) m.content = [];
          m.content.push({ cachePoint: { type: 'default' } });
          userTurnsProcessed += 1;
          try {
            const hasToolResult = Array.isArray(m.content) && m.content.some((c: any) => c && typeof c === 'object' && 'toolResult' in c);
            cachedKinds.push(hasToolResult ? 'TR' : 'U');
          } catch {}
        }
      }
    }
    messagesWithCache.push(m);
  }

  messagesWithCache.reverse();
  try {
    const dbg = String(process.env.AGENT_DEBUG_CACHEPOINTS ?? '').toLowerCase();
    if (dbg === '1' || dbg === 'true') {
      // eslint-disable-next-line no-console
      console.log(`[CachePoints] isClaude=${isClaude} isNova=${isNova} addedOn=${cachedKinds.join(',')}`);
    }
  } catch {}
  return messagesWithCache;
}


