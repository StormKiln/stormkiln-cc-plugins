// The bar's arithmetic, kept free of `$` so tests can drive it directly.

import type { BarCategory, CacheReset, CacheResetCause, ContextSnapshot, LoopStat } from '../types'
import { contextUsd, type CacheTtl, type Usage, usageUsd } from './pricing'

export const MAIN = 'main'

// A request counts as a cache rewrite when it writes back at least this share of
// the context the loop had cached, and reads back less than it.
const REWRITE_SHARE = 0.5
// Writes smaller than this are a turn's new content, not a reset.
const REWRITE_MIN_TOKENS = 4096
const RESETS_KEPT = 5

export type Options = {
  sessionCostWarnUsd: number
  requestCostWarnUsd: number
  compactWarnPercent: number
  cacheTtl: CacheTtl
  maxSubagentRows: number
}

export function readOptions(raw: Readonly<Record<string, unknown>>): Options {
  const num = (key: string, fallback: number) => {
    const value = raw[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    sessionCostWarnUsd: num('sessionCostWarnUsd', 10),
    requestCostWarnUsd: num('requestCostWarnUsd', 0.5),
    compactWarnPercent: Math.min(99, num('compactWarnPercent', 80)),
    cacheTtl: raw.cacheTtl === '1h' ? '1h' : '5m',
    maxSubagentRows: Math.round(num('maxSubagentRows', 4)),
  }
}

export function ttlMs(ttl: CacheTtl): number {
  return ttl === '1h' ? 3_600_000 : 300_000
}

export function newLoop(id: string, label: string, agentType: string, model: string, now: number): LoopStat {
  return {
    id,
    label,
    agentType,
    model,
    steps: 0,
    contextTokens: 0,
    peakContextTokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usd: 0,
    resets: [],
    resetCount: 0,
    resetExtraUsd: 0,
    startedAt: now,
    lastStepAt: 0,
    isDone: false,
  }
}

export type StepFacts = {
  model: string
  usage: Usage
  /** When the request started: the cache TTL runs from a request's start. */
  startedAt: number
  /** A compaction ran in this loop since its last request. */
  afterCompaction: boolean
}

/**
 * Folds one request into its loop, and says whether that request rewrote the
 * cache: most of what the loop had cached was written again instead of read.
 */
export function applyStep(loop: LoopStat, step: StepFacts, ttl: CacheTtl): { loop: LoopStat; reset: CacheReset | null } {
  const { usage, model, startedAt } = step
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const previous = loop.contextTokens
  let reset: CacheReset | null = null

  const isRewrite =
    loop.steps > 0 &&
    previous > 0 &&
    usage.cache_creation_input_tokens >= REWRITE_MIN_TOKENS &&
    usage.cache_creation_input_tokens >= previous * REWRITE_SHARE &&
    usage.cache_read_input_tokens < previous * REWRITE_SHARE

  if (isRewrite) {
    const idleMs = Math.max(0, startedAt - loop.lastStepAt)
    const cause: CacheResetCause = step.afterCompaction
      ? 'compaction'
      : loop.model !== '' && loop.model !== model
        ? 'model'
        : idleMs >= ttlMs(ttl)
          ? 'idle'
          : 'prefix'
    const rewritten = contextUsd(model, usage.cache_creation_input_tokens, ttl)
    reset = {
      at: startedAt,
      tokens: usage.cache_creation_input_tokens,
      extraUsd: Math.max(0, rewritten.cold - rewritten.warm),
      cause,
      idleMs,
    }
  }

  const next: LoopStat = {
    ...loop,
    model,
    steps: loop.steps + 1,
    contextTokens: prompt,
    peakContextTokens: Math.max(loop.peakContextTokens, prompt),
    input: loop.input + usage.input_tokens,
    output: loop.output + usage.output_tokens,
    cacheRead: loop.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: loop.cacheWrite + usage.cache_creation_input_tokens,
    usd: loop.usd + usageUsd(model, usage, ttl),
    lastStepAt: startedAt,
    resets: reset ? [...loop.resets, reset].slice(-RESETS_KEPT) : loop.resets,
    resetCount: loop.resetCount + (reset ? 1 : 0),
    resetExtraUsd: loop.resetExtraUsd + (reset?.extraUsd ?? 0),
  }
  return { loop: next, reset }
}

/** Share of prompt tokens served from the cache across the given loops, 0 to 1. */
export function cacheHitRate(loops: readonly LoopStat[]): number | null {
  let read = 0
  let total = 0
  for (const loop of loops) {
    read += loop.cacheRead
    total += loop.cacheRead + loop.cacheWrite + loop.input
  }
  return total > 0 ? read / total : null
}

// ---------------------------------------------------------------- the bar

export type Segment = { name: string; color: string; kind: BarCategory['kind']; cells: number }

/** Splits `width` cells among the window's categories by largest remainder. */
export function layoutBar(categories: readonly BarCategory[], windowTokens: number, width: number): Segment[] {
  const shown = categories.filter(c => c.kind !== 'deferred' && c.tokens > 0)
  const total = Math.max(windowTokens, shown.reduce((sum, c) => sum + c.tokens, 0))
  if (width <= 0 || total <= 0) return []
  const exact = shown.map(c => (c.tokens / total) * width)
  const cells = exact.map(Math.floor)
  // A used category with any tokens keeps at least one cell so its color shows.
  shown.forEach((c, i) => {
    if (c.kind === 'used' && cells[i] === 0 && exact[i]! > 0) cells[i] = 1
  })
  let left = width - cells.reduce((sum, n) => sum + n, 0)
  const order = exact.map((value, i) => ({ i, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest)
  for (const { i } of order) {
    if (left <= 0) break
    cells[i]! += 1
    left -= 1
  }
  // Rounding up tiny categories can overshoot: take it back from the largest.
  while (left < 0) {
    const largest = cells.indexOf(Math.max(...cells))
    cells[largest]! -= 1
    left += 1
  }
  return shown.map((c, i) => ({ name: c.name, color: c.color, kind: c.kind, cells: cells[i]! })).filter(s => s.cells > 0)
}

export function glyphFor(kind: BarCategory['kind']): string {
  return kind === 'free' ? '░' : kind === 'buffer' ? '▒' : '█'
}

// ---------------------------------------------------------------- formatting

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(2)}`
  if (n > 0) return `$${n.toFixed(3)}`
  return '$0'
}

export function fmtDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

export function describeCause(reset: CacheReset): string {
  switch (reset.cause) {
    case 'idle':
      return `idle ${fmtDuration(reset.idleMs)}`
    case 'model':
      return 'model switch'
    case 'compaction':
      return 'compaction'
    case 'prefix':
      return 'prompt prefix changed'
  }
}

// ---------------------------------------------------------------- the main window

export type WindowFacts = {
  usedTokens: number
  windowTokens: number
  percentOfWindow: number
  compactAt: number | null
  /** Context as a share of the auto-compact threshold, 0-100+; null when compaction is off. */
  percentOfCompact: number | null
  tokensToCompact: number | null
  perRequest: { warm: number; cold: number }
}

export function windowFacts(snapshot: ContextSnapshot, model: string, ttl: CacheTtl): WindowFacts {
  const used = snapshot.totalTokens
  const compactAt = snapshot.compactAt
  return {
    usedTokens: used,
    windowTokens: snapshot.windowTokens,
    percentOfWindow: snapshot.windowTokens > 0 ? (used / snapshot.windowTokens) * 100 : 0,
    compactAt,
    percentOfCompact: compactAt ? (used / compactAt) * 100 : null,
    tokensToCompact: compactAt ? Math.max(0, compactAt - used) : null,
    perRequest: contextUsd(model, used, ttl),
  }
}

/** Per-request cost of carrying one category, at warm-cache prices. */
export function categoryUsd(model: string, tokens: number, ttl: CacheTtl): number {
  return contextUsd(model, tokens, ttl).warm
}

// ---------------------------------------------------------------- advice

export type Advice = { level: 'info' | 'warn' | 'alert'; text: string }

const isCategory = (c: BarCategory, ...words: string[]) =>
  c.kind === 'used' && words.some(word => c.name.toLowerCase().includes(word))

/**
 * What the person could do differently, most pressing first. Each line names
 * the cost and the action, so it can be acted on without reading the bar.
 */
export function advise(
  snapshot: ContextSnapshot | null,
  loops: readonly LoopStat[],
  now: number,
  options: Options,
): Advice[] {
  const out: Advice[] = []
  const main = loops.find(l => l.id === MAIN)
  const model = main?.model || snapshot?.model || 'claude-opus-5-5'
  const subs = loops.filter(l => l.id !== MAIN)

  if (snapshot) {
    const w = windowFacts(snapshot, model, options.cacheTtl)
    if (w.percentOfCompact !== null && w.tokensToCompact !== null) {
      if (w.percentOfCompact >= 95) {
        out.push({
          level: 'alert',
          text: `Auto-compact is ${fmtTokens(w.tokensToCompact)} away. /compact <what to keep> now keeps control of the summary; /clear if the task changed.`,
        })
      } else if (w.percentOfCompact >= options.compactWarnPercent) {
        out.push({
          level: 'warn',
          text: `${Math.round(w.percentOfCompact)}% of the way to auto-compact (${fmtTokens(w.tokensToCompact)} left). Wrap up this thread, or /compact with a focus hint at a natural break.`,
        })
      }
    }

    if (w.perRequest.cold >= options.requestCostWarnUsd) {
      out.push({
        level: 'warn',
        text: `Each request re-sends ${fmtTokens(w.usedTokens)}: ${fmtUsd(w.perRequest.warm)} on a warm cache, ${fmtUsd(w.perRequest.cold)} if it lapses. /clear between unrelated tasks; reply within the cache window.`,
      })
    }

    const mcp = snapshot.categories.find(c => isCategory(c, 'mcp'))
    if (mcp && mcp.tokens >= Math.max(10_000, snapshot.windowTokens * 0.05)) {
      out.push({
        level: 'info',
        text: `MCP tools hold ${fmtTokens(mcp.tokens)} (${fmtUsd(categoryUsd(model, mcp.tokens, options.cacheTtl))}/request). Disable servers you are not using in /mcp.`,
      })
    }

    const memory = snapshot.categories.find(c => isCategory(c, 'memory'))
    if (memory && memory.tokens >= 8_000) {
      out.push({
        level: 'info',
        text: `Memory files hold ${fmtTokens(memory.tokens)}, sent with every request. Trim CLAUDE.md files that /context lists as largest.`,
      })
    }

    const messages = snapshot.categories.find(c => isCategory(c, 'message'))
    if (messages && w.percentOfCompact !== null && w.percentOfCompact >= 50 && messages.tokens >= w.usedTokens * 0.7) {
      out.push({
        level: 'info',
        text: `Conversation history is ${Math.round((messages.tokens / w.usedTokens) * 100)}% of context. If earlier work is done, /compact keeps the gist at a fraction of the cost.`,
      })
    }
  }

  // Cache rewrites: the costliest recent one, main or subagent.
  const recent = loops
    .flatMap(l => l.resets.map(r => ({ loop: l, reset: r })))
    .filter(x => now - x.reset.at < 30 * 60_000)
    .sort((a, b) => b.reset.extraUsd - a.reset.extraUsd)[0]
  if (recent) {
    const who = recent.loop.id === MAIN ? 'The main conversation' : `Subagent "${recent.loop.label}"`
    const why =
      recent.reset.cause === 'idle'
        ? recent.loop.id === MAIN
          ? `after ${fmtDuration(recent.reset.idleMs)} idle. Replies within ${options.cacheTtl} keep the cache warm.`
          : `after ${fmtDuration(recent.reset.idleMs)} between requests. Keep slow commands and waits out of subagents, or resume them sooner.`
        : recent.reset.cause === 'model'
          ? 'after a model switch. Caches are per model: switch models at task boundaries, not mid-thread.'
          : recent.reset.cause === 'compaction'
            ? 'after compaction. Expected, but compact at task boundaries rather than mid-task.'
            : 'because the prompt prefix changed (tools, MCP servers, settings or system prompt). Avoid toggling those mid-task.'
    out.push({
      level: recent.reset.extraUsd >= 0.25 ? 'warn' : 'info',
      text: `${who} rewrote ${fmtTokens(recent.reset.tokens)} of cache (+${fmtUsd(recent.reset.extraUsd)}) ${why}`,
    })
  }

  // Subagents' share of the spend.
  const subUsd = subs.reduce((sum, l) => sum + l.usd, 0)
  const allUsd = subUsd + (main?.usd ?? 0)
  if (subs.length > 0 && allUsd > 0.5 && subUsd / allUsd >= 0.5) {
    const top = [...subs].sort((a, b) => b.usd - a.usd)[0]!
    out.push({
      level: 'info',
      text: `Subagents are ${Math.round((subUsd / allUsd) * 100)}% of spend (top: "${top.label}" ${fmtUsd(top.usd)}). Give searches narrower prompts, or a cheaper model (model: "haiku").`,
    })
  }

  if (main && snapshot && main.lastStepAt > 0) {
    const left = ttlMs(options.cacheTtl) - (now - main.lastStepAt)
    const w = windowFacts(snapshot, model, options.cacheTtl)
    if (left > 0 && left < 90_000 && w.perRequest.cold - w.perRequest.warm >= 0.05) {
      out.push({
        level: 'info',
        text: `Cache expires in ${fmtDuration(left)}. Sending the next prompt before then saves ~${fmtUsd(w.perRequest.cold - w.perRequest.warm)}.`,
      })
    }
  }

  const rank = { alert: 0, warn: 1, info: 2 } as const
  return out.map((a, i) => ({ a, i })).sort((x, y) => rank[x.a.level] - rank[y.a.level] || x.i - y.i).map(x => x.a)
}

// ---------------------------------------------------------------- warnings worth a toast

export type Warning = { key: string; text: string }

/** Thresholds crossed now; `warned` keys are the ones already raised this session. */
export function warnings(
  snapshot: ContextSnapshot | null,
  loops: readonly LoopStat[],
  warned: readonly string[],
  options: Options,
): Warning[] {
  const out: Warning[] = []
  const has = (key: string) => warned.includes(key)
  const main = loops.find(l => l.id === MAIN)
  const model = main?.model || snapshot?.model || 'claude-opus-5-5'

  if (snapshot) {
    const w = windowFacts(snapshot, model, options.cacheTtl)
    if (w.percentOfCompact !== null && w.tokensToCompact !== null) {
      if (w.percentOfCompact >= 95 && !has('compact-95')) {
        out.push({ key: 'compact-95', text: `Context: auto-compact in ${fmtTokens(w.tokensToCompact)}. /compact <focus> now to choose what is kept.` })
      } else if (w.percentOfCompact >= options.compactWarnPercent && !has('compact-warn')) {
        out.push({ key: 'compact-warn', text: `Context is ${Math.round(w.percentOfCompact)}% of the way to auto-compact.` })
      }
    }
    if (w.perRequest.cold >= options.requestCostWarnUsd && !has('request-cost')) {
      out.push({ key: 'request-cost', text: `Context now costs ${fmtUsd(w.perRequest.cold)} per request on a cold cache (${fmtUsd(w.perRequest.warm)} warm).` })
    }
    if (snapshot.sessionUsd !== null) {
      // Warn at the threshold and at each doubling past it.
      let level = options.sessionCostWarnUsd
      while (snapshot.sessionUsd >= level * 2) level *= 2
      const key = `session-${level}`
      if (snapshot.sessionUsd >= level && !has(key)) {
        out.push({ key, text: `This session has cost ${fmtUsd(snapshot.sessionUsd)}. /clear before starting an unrelated task.` })
      }
    }
  }

  for (const loop of loops) {
    const last = loop.resets[loop.resets.length - 1]
    if (!last || last.extraUsd < 0.05) continue
    const key = `reset-${loop.id}-${loop.resetCount}`
    if (has(key)) continue
    const who = loop.id === MAIN ? 'Main conversation' : `Subagent "${loop.label}"`
    out.push({ key, text: `${who} rewrote ${fmtTokens(last.tokens)} of cache (+${fmtUsd(last.extraUsd)}, ${describeCause(last)}).` })
  }
  return out
}
