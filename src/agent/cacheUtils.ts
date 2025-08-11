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

  for (const message of [...messages].reverse()) {
    const m: Message = JSON.parse(JSON.stringify(message));
    if (m.role === 'user' && userTurnsProcessed < maxPoints) {
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
      }
    }
    messagesWithCache.push(m);
  }

  messagesWithCache.reverse();
  return messagesWithCache;
}


