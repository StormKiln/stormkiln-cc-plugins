/** One /context category as the bar draws it. */
export type BarCategory = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

/** The main context window, as /context breaks it down, plus the session's real cost. */
export type ContextSnapshot = {
  categories: BarCategory[]
  totalTokens: number
  windowTokens: number
  compactAt: number | null
  model: string
  sessionUsd: number | null
  at: number
}

/** Why a loop's prompt cache had to be written again. */
export type CacheResetCause = 'idle' | 'model' | 'compaction' | 'prefix'

/** One cache rewrite: a request that wrote most of the context back to the cache. */
export type CacheReset = {
  at: number
  tokens: number
  /** What the rewrite cost beyond a cache read of the same tokens. */
  extraUsd: number
  cause: CacheResetCause
  idleMs: number
}

/** A prompt-cache lifetime. */
export type CacheTtl = '5m' | '1h'

/** How the session is billed: a subscription login, or per token (API key, Bedrock, Vertex, a gateway). */
export type Billing = 'subscription' | 'api' | 'unknown'

/**
 * Where a loop's cache TTL came from, strongest first: the person's setting;
 * Claude Code's own report (a model switch); the subagent's final usage, which
 * splits its writes by TTL; a cache read seen after more than 5 minutes idle;
 * the billing type's usual TTL; or the 5-minute default.
 */
export type TtlSource = 'setting' | 'engine' | 'agent-result' | 'observed' | 'plan' | 'default'

/** Running totals for one model loop: the main conversation or a subagent. */
export type LoopStat = {
  id: string
  label: string
  agentType: string
  model: string
  steps: number
  contextTokens: number
  peakContextTokens: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  resets: CacheReset[]
  resetCount: number
  resetExtraUsd: number
  startedAt: number
  lastStepAt: number
  isDone: boolean
  /** The TTL this loop's cache writes are priced at and its idle expiry is judged by. */
  ttl: CacheTtl
  ttlSource: TtlSource
  /** The strongest direct evidence of this loop's TTL seen so far. */
  ttlEvidence: { ttl: CacheTtl; source: 'engine' | 'agent-result' | 'observed' } | null
  /** Cache writes at the plain input rate, so `usd` can be re-priced when `ttl` changes. */
  writeBaseUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      isVisible: boolean
      /** Set by `/context-bar on|off --here`: this session stops following the shared on/off. */
      isSessionOnly: boolean
      billing: Billing
      snapshot: ContextSnapshot | null
      loops: LoopStat[]
      warned: string[]
      pendingCompaction: boolean
      tick: number
    }
  }
}
