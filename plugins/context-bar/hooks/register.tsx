import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BarCategory, ContextSnapshot, LoopStat } from '../types'
import {
  MAIN,
  advise,
  applyStep,
  billingFrom,
  cacheHitRate,
  categoryUsd,
  describeCause,
  describeTtlSource,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  glyphFor,
  layoutBar,
  mainTtl,
  newLoop,
  readOptions,
  retime,
  ttlFromCacheCreation,
  type Options,
  type TtlContext,
  ttlMs,
  warnings,
  windowFacts,
  withEvidence,
} from './logic'

const isVisible = atom({ plugin: 'context-bar', key: 'isVisible' } as const, true)
const isSessionOnly = atom({ plugin: 'context-bar', key: 'isSessionOnly' } as const, false)
const billing = atom({ plugin: 'context-bar', key: 'billing' } as const, 'unknown')
const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
const loops = atom({ plugin: 'context-bar', key: 'loops' } as const, [])
const warned = atom({ plugin: 'context-bar', key: 'warned' } as const, [])
const pendingCompaction = atom({ plugin: 'context-bar', key: 'pendingCompaction' } as const, false)
const tick = atom({ plugin: 'context-bar', key: 'tick' } as const, 0)

const STORE_VISIBLE = 'isVisible'
const COMMAND = 'context-bar'

type $ = EngineInterface

async function ttlContext($: $, options: Options): Promise<TtlContext> {
  return { setting: options.cacheTtl, billing: await read($, billing) }
}

/** Puts `loop` (made with `make` when missing) through `change` in the loop list. */
async function updateLoop($: $, id: string, make: () => LoopStat, change: (loop: LoopStat) => LoopStat) {
  await update($, loops, list =>
    list.some(l => l.id === id) ? list.map(l => (l.id === id ? change(l) : l)) : [...list, change(make())],
  )
}

async function refresh($: $, options: Options) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const hasResponded = (await read($, loops)).some(l => l.id === MAIN && l.steps > 0)
  const billed = billingFrom(usage.rateLimits.map(r => r.kind), hasResponded)
  if (billed !== (await read($, billing)) && billed !== 'unknown') {
    await update($, billing, () => billed)
    const ctx = await ttlContext($, options)
    await update($, loops, list => list.map(l => retime(l, ctx)))
  }
  const b = usage.context.breakdown
  if (!b) return
  const snap: ContextSnapshot = {
    categories: b.categories.map(
      (c): BarCategory => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }),
    ),
    totalTokens: b.totalTokens,
    windowTokens: b.rawMaxTokens,
    compactAt: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
    model: b.model,
    sessionUsd: usage.cost?.usd ?? null,
    at: await $.clock.now(),
  }
  await update($, snapshot, () => snap)
  await raiseWarnings($, options)
}

/** Follows the on/off shared by every session, unless this one chose its own with --here. */
async function followStored($: $) {
  if (await read($, isSessionOnly)) return
  const stored = await $.store.get(STORE_VISIBLE)
  if (typeof stored === 'boolean' && stored !== (await read($, isVisible))) await update($, isVisible, () => stored)
}

async function raiseWarnings($: $, options: Options) {
  const raised = warnings(await read($, snapshot), await read($, loops), await read($, warned), options, await read($, billing))
  if (raised.length === 0) return
  await update($, warned, list => [...list, ...raised.map(w => w.key)])
  if (!(await read($, isVisible))) return
  for (const w of raised) $.ui.toast(w.text, { timeoutMs: 8000 })
}

export const register: Register = (on, rawOptions) => {
  const options = readOptions(rawOptions)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the context-window cost bar above the prompt',
      argumentHint: '[on|off] [--here] | reset',
    })
    await followStored($)
    // Keeps the cache countdown and its advice current while the session sits
    // idle, and picks up /context-bar on|off run in another session.
    $.clock.every(15_000, () => {
      void update($, tick, n => n + 1)
      void followStored($).catch(() => undefined)
    })
    void refresh($, options).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.includes('reset')) {
      await update($, loops, () => [])
      await update($, warned, () => [])
      return { text: 'Context bar: cost and cache counters reset.' }
    }
    const isHere = words.includes('--here')
    const current = await read($, isVisible)
    const nextVisible = words.includes('on') ? true : words.includes('off') ? false : !current
    await update($, isVisible, () => nextVisible)
    await update($, isSessionOnly, () => isHere)
    if (!isHere) await $.store.set(STORE_VISIBLE, nextVisible)
    if (nextVisible) await refresh($, options).catch(() => undefined)
    const where = isHere
      ? ' in this session only; /context-bar on|off to follow every session again.'
      : ' in every session.'
    return { text: `Context bar ${nextVisible ? 'shown' : 'hidden'}${where}` }
  }).catch(() => ({ text: 'Context bar: the command failed; see claude --debug.' }))

  // Name each subagent's loop after the task it was given.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if ('agentId' in result && result.agentId) {
      const id = result.agentId
      const label = e.description || e.subagentType
      const now = await $.clock.now()
      await update($, loops, list =>
        list.some(l => l.id === id)
          ? list.map(l => (l.id === id ? { ...l, label, agentType: e.subagentType } : l))
          : [...list, newLoop(id, label, e.subagentType, result.model ?? '', now)],
      )
    }
    return result
  }).catch(($, e, next) => next(e))

  // Every model request, main or subagent: its usage, cost and any cache rewrite.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    const id = e.agentId ?? MAIN
    try {
      const afterCompaction = id === MAIN && (await read($, pendingCompaction))
      if (afterCompaction) await update($, pendingCompaction, () => false)
      const ctx = await ttlContext($, options)
      await update($, loops, list => {
        const existing =
          list.find(l => l.id === id) ??
          newLoop(id, id === MAIN ? 'main' : id.slice(0, 8), id === MAIN ? 'main' : 'agent', '', startedAt)
        const { loop } = applyStep(existing, { model: usage.model || e.model, usage, startedAt, afterCompaction }, ctx)
        return list.some(l => l.id === id) ? list.map(l => (l.id === id ? loop : l)) : [...list, loop]
      })
      await raiseWarnings($, options)
    } catch {
      // Accounting must never get in the way of the turn.
    }
    return result
  })

  // Claude Code says which TTL the main conversation caches at when the model switches.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const ctx = await ttlContext($, options)
    const now = await $.clock.now()
    await updateLoop(
      $,
      MAIN,
      () => newLoop(MAIN, 'main', 'main', '', now),
      l => withEvidence(l, { ttl: e.cache_ttl, source: 'engine' }, ctx),
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  // A finished subagent's usage splits its cache writes by TTL.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const result = await next(e)
    const record = result.result as { agentId?: string; usage?: { cache_creation?: Parameters<typeof ttlFromCacheCreation>[0] } } | undefined
    const ttl = ttlFromCacheCreation(record?.usage?.cache_creation)
    const id = record?.agentId
    if (ttl && id) {
      const ctx = await ttlContext($, options)
      const known = (await read($, loops)).some(l => l.id === id)
      if (known) await update($, loops, list => list.map(l => (l.id === id ? withEvidence(l, { ttl, source: 'agent-result' }, ctx) : l)))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      const id = e.agentId
      await update($, loops, list => list.map(l => (l.id === id ? { ...l, isDone: true } : l)))
    } else {
      await refresh($, options).catch(() => undefined)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && result.messages) {
      await update($, pendingCompaction, () => true)
      await update($, warned, list => list.filter(key => !key.startsWith('compact-') && key !== 'request-cost'))
      await refresh($, options).catch(() => undefined)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context') || e.changed.includes('cost')) await refresh($, options).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, loops, () => [])
      await update($, snapshot, () => null)
      await update($, warned, () => [])
      await update($, pendingCompaction, () => false)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isVisible))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)
    await read($, tick)
    const all = await read($, loops)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const width = Math.max(20, e.props.bodyColumns)
    const main = all.find(l => l.id === MAIN)
    const subs = all.filter(l => l.id !== MAIN)
    const model = main?.model || snap.model
    const billed = await read($, billing)
    const ttl = mainTtl(all, { setting: options.cacheTtl, billing: billed })
    const ttlSource = main?.ttlSource
    const w = windowFacts(snap, model, ttl)

    // Row 1: the stacked bar and where the window stands.
    const compactNote =
      w.percentOfCompact === null
        ? 'auto-compact off'
        : `${Math.round(w.percentOfCompact)}% of compact`
    const summary = ` ${fmtTokens(w.usedTokens)}/${fmtTokens(w.windowTokens)} · ${compactNote}`
    const barWidth = Math.max(10, Math.min(60, width - summary.length - 1))
    const segments = layoutBar(snap.categories, snap.windowTokens, barWidth)
    const summaryColor =
      w.percentOfCompact !== null && w.percentOfCompact >= 95
        ? 'error'
        : w.percentOfCompact !== null && w.percentOfCompact >= options.compactWarnPercent
          ? 'warning'
          : undefined

    // Row 2: the legend, largest first, each with its per-request cost.
    const used = snap.categories.filter(c => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)

    // Row 3: money.
    const mainUsd = main?.usd ?? 0
    const subUsd = subs.reduce((sum, l) => sum + l.usd, 0)
    const hit = cacheHitRate(all)
    const cacheLeft = main && main.lastStepAt > 0 ? ttlMs(ttl) - (now - main.lastStepAt) : null
    const cacheNote =
      cacheLeft === null
        ? null
        : cacheLeft > 0
          ? `cache warm ${fmtDuration(cacheLeft)} of ${ttl}`
          : `cache cold (${ttl} TTL): next prompt ${fmtUsd(w.perRequest.cold)}`
    // On a subscription the dollars are API list-price equivalents, not a bill.
    const billingNote = billed === 'subscription' ? ' (subscription: API-price equivalent)' : billed === 'api' ? ' (API billing)' : ''
    const resetCount = all.reduce((sum, l) => sum + l.resetCount, 0)
    const resetUsd = all.reduce((sum, l) => sum + l.resetExtraUsd, 0)

    const advice = advise(snap, all, now, options, billed)
    const room = Math.max(3, e.props.maxRows)
    const adviceRows = advice.slice(0, room >= 7 ? 2 : 1)
    const subRoom = Math.max(0, Math.min(options.maxSubagentRows, room - 3 - adviceRows.length))
    const shownSubs = [...subs]
      .sort((a, b) => Number(a.isDone) - Number(b.isDone) || b.lastStepAt - a.lastStepAt)
      .slice(0, subRoom)
    const hiddenSubs = subs.length - shownSubs.length

    // One line per subagent: its context, requests, cost and cache rewrites.
    function subagentRow(l: LoopStat) {
      const cells = 8
      const filled = snap!.windowTokens > 0 ? Math.min(cells, Math.round((l.contextTokens / snap!.windowTokens) * cells)) : 0
      const last = l.resets[l.resets.length - 1]
      const isFreshReset = last !== undefined && now - last.at < 10 * 60_000
      return (
        <Text wrap="truncate-end">
          <Text color={l.isDone ? 'inactive' : 'success'}>{l.isDone ? '  ✓ ' : '  ● '}</Text>
          <Text dimColor={l.isDone}>{`${l.agentType !== 'agent' ? `${l.agentType}: ` : ''}${l.label}  `}</Text>
          <Text color="promptBorder">{'█'.repeat(filled)}</Text>
          <Text color="inactive">{'░'.repeat(cells - filled)}</Text>
          <Text dimColor>{` ${fmtTokens(l.contextTokens)} ctx · ${l.steps} req · ~${fmtUsd(l.usd)} · ${l.ttl} cache`}</Text>
          {l.resetCount > 0 && last ? (
            <Text color={isFreshReset ? 'error' : 'warning'}>
              {` · ⟳${l.resetCount} rewrite${l.resetCount === 1 ? '' : 's'} +${fmtUsd(l.resetExtraUsd)} (last ${fmtDuration(now - last.at)} ago: ${describeCause(last)}, ${fmtTokens(last.tokens)})`}
            </Text>
          ) : (
            <Text dimColor>{l.steps > 1 ? ' · cache ok' : ''}</Text>
          )}
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text>
            {segments.map(s => (
              <Text color={s.kind === 'free' ? 'inactive' : s.color}>{glyphFor(s.kind).repeat(s.cells)}</Text>
            ))}
          </Text>
          <Text color={summaryColor} wrap="truncate-end">
            {summary}
          </Text>
        </Box>
        <Text wrap="truncate-end">
          {used.map((c, i) => (
            <Text>
              {i > 0 ? '  ' : ''}
              <Text color={c.color}>■</Text>
              <Text> {c.name} {fmtTokens(c.tokens)}</Text>
              <Text dimColor> {fmtUsd(categoryUsd(model, c.tokens, ttl))}</Text>
            </Text>
          ))}
          <Text dimColor>{used.length > 0 ? '  per request' : ''}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text bold>{snap.sessionUsd !== null ? `${fmtUsd(snap.sessionUsd)} session` : `~${fmtUsd(mainUsd + subUsd)} est.`}</Text>
          <Text dimColor>
            {billingNote}
            {` · main ~${fmtUsd(mainUsd)}`}
            {subs.length > 0 ? ` · ${subs.length} subagent${subs.length === 1 ? '' : 's'} ~${fmtUsd(subUsd)}` : ''}
            {` · next request ${fmtUsd(w.perRequest.warm)} warm / ${fmtUsd(w.perRequest.cold)} cold`}
            {hit !== null ? ` · ${Math.round(hit * 100)}% cached` : ''}
          </Text>
          {resetCount > 0 ? (
            <Text color="warning">{` · ⟳${resetCount} cache rewrite${resetCount === 1 ? '' : 's'} +${fmtUsd(resetUsd)}`}</Text>
          ) : null}
          {cacheNote ? (
            <Text color={cacheLeft !== null && cacheLeft <= 0 ? 'warning' : 'success'}>{` · ${cacheNote}`}</Text>
          ) : null}
          {cacheNote && ttlSource ? <Text dimColor>{` (${describeTtlSource(ttlSource)})`}</Text> : null}
        </Text>
        {shownSubs.map(l => subagentRow(l))}
        {hiddenSubs > 0 ? <Text dimColor>{`  +${hiddenSubs} more subagent${hiddenSubs === 1 ? '' : 's'}`}</Text> : null}
        {adviceRows.map(a => (
          <Text color={a.level === 'alert' ? 'error' : a.level === 'warn' ? 'warning' : 'suggestion'} wrap="truncate-end">
            → {a.text}
          </Text>
        ))}
      </Box>
    )
  })
}
