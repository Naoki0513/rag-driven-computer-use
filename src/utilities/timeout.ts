export type TimeoutKind = 'agent' | 'crawler' | 'generic';

export function getTimeoutMs(kind: TimeoutKind = 'generic'): number {
  const env = process.env as Record<string, any>;
  const globalVal = String(env.PLAYWRIGHT_TIMEOUT_MS ?? '').trim();
  const agentVal = String(env.AGENT_PLAYWRIGHT_TIMEOUT_MS ?? '').trim();
  const crawlerVal = String(env.CRAWLER_PLAYWRIGHT_TIMEOUT_MS ?? '').trim();

  let chosen: string | undefined;
  if (kind === 'agent') {
    chosen = agentVal || globalVal;
  } else if (kind === 'crawler') {
    chosen = crawlerVal || globalVal;
  } else {
    chosen = globalVal || agentVal || crawlerVal;
  }

  const n = Number(chosen);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  // デフォルトは 30000ms (30秒)
  return 30000;
}


