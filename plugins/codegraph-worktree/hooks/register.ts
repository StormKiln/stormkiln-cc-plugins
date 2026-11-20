import type { EngineInterface, Register } from 'claude-code'

import {
  bundledNodeFor,
  codegraphArgv,
  contextFor,
  isLinkedWorktree,
  isUnsafeRoot,
  isWindows,
  joinPath,
  noticeFor,
  normalizePath,
  parseCloneReport,
  parseRevParse,
  parseWorktreeList,
  pathCandidates,
  sourceCandidates,
  type Outcome,
  type Platform,
} from './logic'

type $ = EngineInterface

/** Where CodeGraph is installed: its launcher, and a Node to run our copy script on. */
type Tooling = { launcher: string; node: string | null }

/** How long a session start waits for the index before it lets the work run on. */
const START_BUDGET_MS = 4_000
/** The copy itself: instant copy-on-write, seconds for a large full copy. */
const COPY_TIMEOUT_MS = 120_000
/** After a failed `codegraph init`, leave that tree alone this long. */
const INIT_RETRY_MS = 24 * 60 * 60 * 1000
/** Recommend installing CodeGraph at most this often. */
const RECOMMEND_EVERY_MS = 24 * 60 * 60 * 1000

// Per process: a reload starts these over, which costs a repeat check only.
const config = { autoInit: true, copyIntoWorktrees: true }
const inflight = new Map<string, Promise<Outcome>>()
let platformOnce: Promise<Platform> | undefined
let toolingOnce: Promise<Tooling | null> | undefined
/** Trees a `codegraph sync` of ours is running in. */
const syncing = new Set<string>()

/** Written by the copy script; `done` once a sync has brought the copy to this branch. */
const SYNC_MARKER = 'cgwt-sync'

function debug($: $, text: string) {
  $.ui.log(`codegraph-worktree: ${text}`, { to: 'debug' })
}

function platformOf($: $): Promise<Platform> {
  return (platformOnce ??= $.session
    .info()
    .then((i) => (i.platform ?? 'unknown') as Platform)
    .catch(() => 'unknown' as Platform))
}

async function homeOf($: $): Promise<string | undefined> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
}

/** The real path of a regular file, or null. */
async function isFile($: $, path: string): Promise<string | null> {
  const s = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return s?.kind === 'file' ? (s.realPath ?? path) : null
}

async function findTooling($: $, platform: Platform): Promise<Tooling | null> {
  const pathVar = (await $.env.get('PATH')) ?? (await $.env.get('Path'))
  const pathExt = isWindows(platform) ? await $.env.get('PATHEXT') : undefined
  const home = await homeOf($)
  const candidates = pathCandidates('codegraph', pathVar, platform, pathExt)
  // The installer's default, for a session started without it on PATH.
  if (!isWindows(platform) && home) candidates.push(joinPath(home, '.local', 'bin', 'codegraph'))
  for (const launcher of candidates) {
    const real = await isFile($, launcher)
    if (!real) continue
    let node: string | null = null
    const bundled = bundledNodeFor(real, platform)
    if (await isFile($, bundled)) node = bundled
    else {
      for (const n of pathCandidates('node', pathVar, platform, pathExt)) {
        if (await isFile($, n)) {
          node = n
          break
        }
      }
    }
    return { launcher, node }
  }
  return null
}

function toolingOf($: $, platform: Platform): Promise<Tooling | null> {
  return (toolingOnce ??= findTooling($, platform).catch((err) => {
    debug($, `looking for codegraph failed: ${String(err)}`)
    return null
  }))
}

async function git($: $, cwd: string, args: string[]): Promise<string | null> {
  const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 }).catch(() => undefined)
  return r && r.exitCode === 0 ? r.stdout : null
}

/** Runs a codegraph command to its end without holding up whoever started it. */
function runInBackground($: $, argv: string[], cwd: string, label: string, onEnd?: (ok: boolean) => void) {
  void (async () => {
    let tail = ''
    let ok = false
    try {
      const stream = $.process.spawn({ argv, cwd })
      for await (const piece of stream) tail = (tail + piece.text).slice(-1500)
      const end = await stream.result
      ok = end.code === 0
      if (!ok) debug($, `${label} in ${cwd} ended with ${end.code ?? end.signal}: ${tail.trim()}`)
      else debug($, `${label} in ${cwd} done`)
    } catch (err) {
      debug($, `${label} in ${cwd} did not run: ${String(err)}`)
    }
    try {
      onEnd?.(ok)
    } catch {
      // A reporting failure changes nothing about the index.
    }
  })()
}

async function startInit($: $, root: string, platform: Platform, tools: Tooling, isLinked: boolean, why: string): Promise<Outcome> {
  if (!config.autoInit) return { kind: 'left-alone', root, isLinked, why: 'autoInit is off' }
  if (isUnsafeRoot(root, await homeOf($), platform)) {
    return { kind: 'left-alone', root, isLinked, why: 'home or filesystem root' }
  }
  const key = `init-failed:${normalizePath(root)}`
  const failedAt = Number((await $.store.get(key).catch(() => undefined)) ?? 0)
  const now = await $.clock.now()
  if (failedAt > 0 && now - failedAt < INIT_RETRY_MS) {
    return { kind: 'left-alone', root, isLinked, why: 'codegraph init failed here recently' }
  }
  runInBackground($, codegraphArgv(tools.launcher, platform, ['init', '-y']), root, 'codegraph init', (ok) => {
    void (ok ? $.store.delete(key) : $.store.set(key, now)).catch(() => undefined)
  })
  return { kind: 'initializing', root, isLinked, why }
}

/** Brings a copied index to this tree's branch, then marks it done. */
function startSync($: $, root: string, platform: Platform, tools: Tooling) {
  const key = normalizePath(root).toLowerCase()
  if (syncing.has(key)) return
  syncing.add(key)
  runInBackground($, codegraphArgv(tools.launcher, platform, ['sync', '-q']), root, 'codegraph sync', (ok) => {
    syncing.delete(key)
    if (ok) void $.fs.write(joinPath(root, '.codegraph', SYNC_MARKER), 'done\n').catch(() => undefined)
  })
}

/** A copy whose sync never finished (the session that made it ended first). */
async function needsSync($: $, root: string): Promise<boolean> {
  const text = await $.fs.read(joinPath(root, '.codegraph', SYNC_MARKER)).catch(() => undefined)
  return text?.trim() === 'pending'
}

async function tryCopy($: $, root: string, platform: Platform, tools: Tooling): Promise<Outcome | null> {
  if (!tools.node) {
    debug($, 'no Node runtime found next to codegraph or on PATH; cannot copy an index')
    return null
  }
  const list = await git($, root, ['worktree', 'list', '--porcelain'])
  if (list === null) return null
  const script = joinPath($.plugin.root, 'scripts', 'clone-index.mjs')
  for (const source of sourceCandidates(parseWorktreeList(list), root, platform)) {
    const sourceIndex = joinPath(source, '.codegraph')
    if (!(await $.fs.exists(joinPath(sourceIndex, 'codegraph.db')))) continue
    const r = await $.process
      .run([tools.node, script, sourceIndex, root], { timeoutMs: COPY_TIMEOUT_MS })
      .catch((err) => ({ exitCode: -1, stdout: JSON.stringify({ status: 'failed', reason: String(err) }), stderr: '' }))
    const report = parseCloneReport(r.stdout)
    if (report.status === 'copied') {
      startSync($, root, platform, tools)
      return { kind: 'copied', root, from: source, method: report.method ?? 'copy' }
    }
    if (report.status === 'exists') return { kind: 'ready', root, isLinked: true }
    debug($, `copy from ${source} ${report.status}: ${report.reason ?? ''}`)
  }
  return null
}

async function ensureIndexAt($: $, dir: string): Promise<Outcome> {
  const platform = await platformOf($)
  const rev = await git($, dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  const place = rev === null ? null : parseRevParse(rev)
  if (!place) return { kind: 'not-git' }
  const { root } = place
  const isLinked = isLinkedWorktree(place, platform)

  if (await $.fs.exists(joinPath(root, '.codegraph', 'codegraph.db'))) {
    if (isLinked && (await needsSync($, root))) {
      const tools = await toolingOf($, platform)
      if (tools) startSync($, root, platform, tools)
    }
    return { kind: 'ready', root, isLinked }
  }
  const tools = await toolingOf($, platform)
  if (!tools) return { kind: 'not-installed' }
  // A folder with no database yet: an init under way, or one a person is
  // dealing with. Either way it is not ours to touch.
  if (await $.fs.exists(joinPath(root, '.codegraph'))) {
    return { kind: 'left-alone', root, isLinked, why: '.codegraph exists without a database' }
  }

  if (isLinked && config.copyIntoWorktrees) {
    const copied = await tryCopy($, root, platform, tools)
    if (copied) return copied
    return startInit($, root, platform, tools, isLinked, 'no index to copy from another worktree')
  }
  return startInit($, root, platform, tools, isLinked, 'repository not indexed yet')
}

/** One check per tree at a time, however many events ask for it. */
function ensureIndex($: $, dir: string): Promise<Outcome> {
  const key = normalizePath(dir).toLowerCase()
  const running = inflight.get(key)
  if (running) return running
  const p = ensureIndexAt($, dir)
    .catch((err): Outcome => {
      debug($, `checking ${dir} failed: ${String(err)}`)
      return { kind: 'not-git' }
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** The outcome, or `pending` once the budget runs out (the work runs on). */
async function ensureWithin($: $, dir: string, ms: number): Promise<Outcome> {
  let timedOut = false
  const work = ensureIndex($, dir)
  const timer = $.clock.sleep(ms).then((): Outcome => {
    timedOut = true
    return { kind: 'pending', root: normalizePath(dir), isLinked: true }
  })
  const outcome = await Promise.race([work, timer])
  if (timedOut) {
    // Report what the background work comes to, once it does.
    void work.then((o) => tell($, o))
  }
  return outcome
}

async function tell($: $, outcome: Outcome) {
  const notice = noticeFor(outcome)
  if (notice) $.ui.toast(notice, { timeoutMs: 6000 })
  if (outcome.kind === 'not-installed') {
    const last = Number((await $.store.get('recommended-at').catch(() => undefined)) ?? 0)
    const now = await $.clock.now()
    if (last > 0 && now - last < RECOMMEND_EVERY_MS) return false
    await $.store.set('recommended-at', now).catch(() => undefined)
    $.ui.log('codegraph-worktree: CodeGraph is not installed. See https://github.com/colbymchenry/codegraph to install it.')
  }
  return true
}

/** The model-facing text for an outcome, after the person has been told. */
async function report($: $, outcome: Outcome): Promise<string[] | undefined> {
  const shouldSay = await tell($, outcome)
  if (outcome.kind === 'not-installed' && !shouldSay) return undefined
  const text = contextFor(outcome)
  return text ? [text] : undefined
}

export const register: Register = (on, options) => {
  config.autoInit = options.autoInit !== false
  config.copyIntoWorktrees = options.copyIntoWorktrees !== false

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const outcome = await ensureWithin($, e.cwd, START_BUDGET_MS)
    const context = await report($, outcome)
    return context ? { ...result, additionalContext: [...(result.additionalContext ?? []), ...context] } : result
  })

  // EnterWorktree moves the session: check the tree it lands in, and tell the
  // model which index to ask.
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (e.tool_name !== 'EnterWorktree') return result
    const response = e.tool_response as { worktreePath?: unknown } | undefined
    const dir = typeof response?.worktreePath === 'string' ? response.worktreePath : e.cwd
    const context = await report($, await ensureWithin($, dir, START_BUDGET_MS))
    return context ? { ...result, additionalContext: [...(result.additionalContext ?? []), ...context] } : result
  })

  // /cd, a host's directory change: nothing to say to the model here, but the
  // tree should have its index.
  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    void ensureIndex($, e.new_cwd).then((o) => tell($, o))
    return result
  })

  // A subagent started in its own worktree (`isolation: "worktree"`).
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    const sessionCwd = await $.session.cwd().catch(() => e.cwd)
    if (normalizePath(sessionCwd) === normalizePath(e.cwd)) return result
    const outcome = await ensureWithin($, e.cwd, START_BUDGET_MS)
    const text = outcome.kind === 'not-installed' ? null : contextFor(outcome)
    return text ? { ...result, additionalContext: [...(result.additionalContext ?? []), text] } : result
  })
}
