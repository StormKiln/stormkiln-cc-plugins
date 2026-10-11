import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage, TurnStepInput, TurnStepResult } from 'claude-code'

import { advise, applyStep, layoutBar, newLoop, readOptions } from '../hooks/logic'
import { contextUsd, normalizeModel, priceFor } from '../hooks/pricing'

const OPTIONS = readOptions({})
const MODEL = 'claude-opus-5-5'

const usage = (read: number, write: number, input = 200, output = 500) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

describe('pricing', () => {
  test('normalizes API ids and display names', async () => {
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModel('Opus 5.5')).toBe('claude-opus-5-5')
    expect(normalizeModel('anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(priceFor('claude-opus-5-5').input).toBe(4)
    expect(priceFor('claude-opus-5').input).toBe(5)
    expect(priceFor('some-future-haiku').input).toBe(0.1)
  })

  test('prices a warm and a cold context', async () => {
    const { warm, cold } = contextUsd(MODEL, 1_000_000, '5m')
    expect(Math.abs(warm - 0.2) < 1e-9).toBe(true)
    expect(Math.abs(cold - 5) < 1e-9).toBe(true)
  })
})

describe('cache rewrites', () => {
  test('the first request writes the cache without counting as a rewrite', async () => {
    const { reset } = applyStep(newLoop('a', 'a', 'Explore', '', 0), { model: MODEL, usage: usage(0, 40_000), startedAt: 0, afterCompaction: false }, '5m')
    expect(reset).toBeNull()
  })

  test('a warm follow-up reads the cache', async () => {
    let loop = applyStep(newLoop('a', 'a', 'Explore', '', 0), { model: MODEL, usage: usage(0, 40_000), startedAt: 0, afterCompaction: false }, '5m').loop
    const step = applyStep(loop, { model: MODEL, usage: usage(40_000, 2_000), startedAt: 60_000, afterCompaction: false }, '5m')
    loop = step.loop
    expect(step.reset).toBeNull()
    expect(loop.steps).toBe(2)
    expect(loop.contextTokens).toBe(42_200)
  })

  test('a rewrite after the TTL is blamed on idling', async () => {
    const first = applyStep(newLoop('a', 'a', 'Explore', '', 0), { model: MODEL, usage: usage(0, 40_000), startedAt: 0, afterCompaction: false }, '5m').loop
    const { loop, reset } = applyStep(first, { model: MODEL, usage: usage(0, 41_000), startedAt: 6 * 60_000, afterCompaction: false }, '5m')
    expect(reset?.cause).toBe('idle')
    expect(reset?.idleMs).toBe(6 * 60_000)
    expect(loop.resetCount).toBe(1)
    expect(loop.resetExtraUsd).toBeGreaterThan(0)
  })

  test('a quick rewrite on a new model is blamed on the switch, otherwise on the prefix', async () => {
    const first = applyStep(newLoop('a', 'a', 'x', '', 0), { model: MODEL, usage: usage(0, 40_000), startedAt: 0, afterCompaction: false }, '5m').loop
    expect(applyStep(first, { model: 'claude-sonnet-5-5', usage: usage(0, 41_000), startedAt: 1000, afterCompaction: false }, '5m').reset?.cause).toBe('model')
    expect(applyStep(first, { model: MODEL, usage: usage(0, 41_000), startedAt: 1000, afterCompaction: false }, '5m').reset?.cause).toBe('prefix')
    expect(applyStep(first, { model: MODEL, usage: usage(0, 41_000), startedAt: 1000, afterCompaction: true }, '5m').reset?.cause).toBe('compaction')
  })
})

describe('bar layout', () => {
  test('fills exactly the width and keeps small used categories visible', async () => {
    const segments = layoutBar(
      [
        { name: 'System prompt', tokens: 3_000, color: 'promptBorder', kind: 'used' },
        { name: 'Messages', tokens: 120_000, color: 'permission', kind: 'used' },
        { name: 'MCP tools', tokens: 500, color: 'claude', kind: 'used' },
        { name: 'Deferred', tokens: 9_000, color: 'inactive', kind: 'deferred' },
        { name: 'Free space', tokens: 31_500, color: 'inactive', kind: 'free' },
        { name: 'Autocompact buffer', tokens: 45_000, color: 'inactive', kind: 'buffer' },
      ],
      200_000,
      40,
    )
    expect(segments.reduce((sum, s) => sum + s.cells, 0)).toBe(40)
    expect(segments.some(s => s.name === 'Deferred')).toBe(false)
    expect(segments.find(s => s.name === 'MCP tools')?.cells).toBeGreaterThan(0)
  })
})

describe('advice', () => {
  test('alerts when auto-compact is close', async () => {
    const snap = {
      categories: [{ name: 'Messages', tokens: 158_000, color: 'permission', kind: 'used' as const }],
      totalTokens: 158_000,
      windowTokens: 200_000,
      compactAt: 160_000,
      model: MODEL,
      sessionUsd: 3,
      at: 0,
    }
    const [first] = advise(snap, [], 0, OPTIONS)
    expect(first?.level).toBe('alert')
    expect(first?.text).toContain('/compact')
  })
})

// ---------------------------------------------------------------- through the engine

const BREAKDOWN: SessionUsage = {
  startedAt: 0,
  context: {
    tokens: 60_000,
    window: 200_000,
    percent: 30,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 4_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'MCP tools', tokens: 18_000, color: 'claude', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 38_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 95_000, color: 'inactive', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 45_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
      totalTokens: 60_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      autocompactSource: 'auto',
      percentage: 30,
      gridRows: [],
      model: MODEL,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      autoCompactThreshold: 155_000,
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
  rateLimits: [],
  cost: { usd: 1.25 },
}

function bottom(on: On) {
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.usage', async () => ({ value: BREAKDOWN }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  // The engine draws nothing above the prompt of its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  // Each step answers with the usage queued for its loop.
  const queued: Record<string, ReturnType<typeof usage>[]> = {}
  on('turn.step', async function* ($, e: TurnStepInput): AsyncGenerator<never, TurnStepResult> {
    const u = queued[e.agentId ?? 'main']?.shift() ?? usage(0, 0)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...u, model: MODEL } }
  })
  return (loop: string, ...steps: ReturnType<typeof usage>[]) => {
    queued[loop] = [...(queued[loop] ?? []), ...steps]
  }
}

async function drain<T, R>(stream: AsyncIterable<T> & { result?: unknown }): Promise<void> {
  for await (const _ of stream) {
    // The step's chunks are not under test.
  }
}

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 150, scroll: { bodyRows: 11, offset: 0, total: 0 } } as never,
}

test('draws the bar, costs and a subagent cache rewrite', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const queue = bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  queue('agent-1', usage(0, 30_000), usage(0, 31_000))
  await drain($.turn.step({ turnId: 't', index: 0, model: MODEL, messageCount: 2, agentId: 'agent-1' }))
  await clock.advance(7 * 60_000)
  await drain($.turn.step({ turnId: 't', index: 1, model: MODEL, messageCount: 4, agentId: 'agent-1' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main-t', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    expect(await ui.find({ text: /60k\/200k/ })).toBeDefined()
    expect(await ui.find({ text: /MCP tools 18k/ })).toBeDefined()
    expect(await ui.find({ text: /\$1\.25 session/ })).toBeDefined()
    expect(await ui.find({ text: /rewrite.*idle 7m/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/context-bar hides and shows the band', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  bottom(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' })

  const off = await $.command.run({ command: 'context-bar', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 150 } } as never)
  expect(off.text).toContain('hidden')
  const hidden = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await hidden.find({ text: /200k/ })).toBeUndefined()
  await hidden.unmount()

  await $.command.run({ command: 'context-bar', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 150 } } as never)
  const shown = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await shown.find({ text: /200k/ })).toBeDefined()
  await shown.unmount()
})
