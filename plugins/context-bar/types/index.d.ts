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
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      isVisible: boolean
      snapshot: ContextSnapshot | null
      loops: LoopStat[]
      warned: string[]
      pendingCompaction: boolean
      tick: number
    }
  }
}
