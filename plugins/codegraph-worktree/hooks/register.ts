import type { EngineInterface, Register } from 'claude-code'

import {
  bundledEntryFor,
  bundledNodeFor,
  codegraphArgv,
  comspecFor,
  contextFor,
  detachedArgv,
  indexDirName,
  isEmptyIndexDir,
  isLinkedWorktree,
  BUNDLE_NODE_FLAGS,
  needsRebuild,
  npmEntryFor,
  isWindows,
  joinPath,
  linkedRoot,
  movedContext,
  noticeFor,
  parseCloneReport,
  parseRevParse,
  parseProbe,
  parseWorktreeList,
  pathCandidates,
  pathKey,
  sourceCandidates,
  unsafeRootReason,
  type Outcome,
  type Platform,
  type Tooling,
} from './logic'

type $ = EngineInterface

/** How long a hook waits for the index before it lets the work run on. */
const START_BUDGET_MS = 4_000
const GIT_TIMEOUT_MS = 10_000
/** The copy itself: instant copy-on-write, seconds for a large full copy. */
const COPY_TIMEOUT_MS = 120_000
/** A source that keeps changing while it is copied: try again this often. */
const COPY_RETRIES = 1
const COPY_RETRY_DELAY_MS = 2_000
/** After starting `codegraph init` in a tree, leave that tree alone this long. */
const INIT_HOLD_MS = 24 * 60 * 60 * 1000
/** After repairing an unfinished index, wait this long before trying again. */
const REPAIR_HOLD_MS = 6 * 60 * 60 * 1000
/** Recommend installing CodeGraph at most this often. */
const RECOMMEND_EVERY_MS = 24 * 60 * 60 * 1000
/** Written by the copy script; `done` once a sync has brought the copy to this branch. */
const SYNC_MARKER = 'cgwt-sync'

// Per process: a reload starts these over, which costs a repeat check only.
const config = { autoInit: true, copyIntoWorktrees: true }
const byDir = new Map<string, Promise<Outcome>>()
const byRoot = new Map<string, Promise<Outcome>>()
const syncing = new Set<string>()
const healthChecked = new Set<string>()
let platformOnce: Promise<Platform> | undefined
let toolingFound: Tooling | undefined
let gitFound: string | undefined
/** The worktree each loop (main, or a subagent by id) was last told to pass as projectPath. */
const toldProjectPath = new Map<string, string>()
/** Context for the next prompt, after a move no hook could report. */
let noteForNextPrompt: string | null = null

function debug($: $, text: string) {
  try {
    $.ui.log(`codegraph-worktree: ${text}`, { to: 'debug' })
  } catch {
    // Logging never fails the work.
  }
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

async function pathOf($: $): Promise<string | undefined> {
  return (await $.env.get('PATH')) ?? (await $.env.get('Path'))
}

/** The real path of a regular file, or null. */
async function isFile($: $, path: string): Promise<string | null> {
  const s = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return s?.kind === 'file' ? (s.realPath ?? path) : null
}

/** Variables every child gets: on Windows, never search the child's own folder for a program. */
function childEnv(platform: Platform): Record<string, string> | undefined {
  return isWindows(platform) ? { NoDefaultCurrentDirectoryInExePath: '1' } : undefined
}

async function findOnPath($: $, name: string, platform: Platform): Promise<string | null> {
  const pathExt = isWindows(platform) ? await $.env.get('PATHEXT') : undefined
  for (const candidate of pathCandidates(name, await pathOf($), platform, pathExt)) {
    if (await isFile($, candidate)) return candidate
  }
  return null
}

/** git by absolute path, so a checkout cannot plant its own. */
async function gitOf($: $, platform: Platform): Promise<string | null> {
  if (gitFound) return gitFound
  const found = await findOnPath($, 'git', platform)
  if (found) gitFound = found
  return found
}

/** Where CodeGraph is installed; looked up again each time until found. */
async function toolingOf($: $, platform: Platform): Promise<Tooling | null> {
  // `codegraph upgrade` moves the bundle: look again if what was found is gone.
  if (toolingFound && (await isFile($, toolingFound.launcher)) && (!toolingFound.node || (await isFile($, toolingFound.node)))) {
    return toolingFound
  }
  toolingFound = undefined
  const home = await homeOf($)
  const pathExt = isWindows(platform) ? await $.env.get('PATHEXT') : undefined
  const candidates = pathCandidates('codegraph', await pathOf($), platform, pathExt)
  // The installer's default, for a session started without it on PATH.
  if (!isWindows(platform) && home) candidates.push(joinPath(home, '.local', 'bin', 'codegraph'))
  for (const launcher of candidates) {
    const real = await isFile($, launcher)
    if (!real) continue
    const bundledNode = (await isFile($, bundledNodeFor(real, platform))) ? bundledNodeFor(real, platform) : null
    const node = bundledNode ?? (await findOnPath($, 'node', platform))
    let direct: Tooling['direct'] = null
    if (bundledNode && (await isFile($, bundledEntryFor(real)))) {
      direct = { node: bundledNode, entry: bundledEntryFor(real), flags: BUNDLE_NODE_FLAGS }
    } else if (node && isWindows(platform) && (await isFile($, npmEntryFor(launcher)))) {
      direct = { node, entry: npmEntryFor(launcher), flags: [] }
    }
    const comspec = isWindows(platform) ? comspecFor(await $.env.get('ComSpec'), await $.env.get('SystemRoot')) : null
    toolingFound = { launcher, node, direct, comspec }
    return toolingFound
  }
  return null
}

async function git($: $, platform: Platform, cwd: string, args: string[]): Promise<string | null> {
  const bin = await gitOf($, platform)
  if (!bin) return null
  const r = await $.process.run([bin, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, env: childEnv(platform) }).catch(() => undefined)
  return r && r.exitCode === 0 ? r.stdout : null
}

/** Runs a codegraph command to its end without holding up whoever started it. */
function runInBackground($: $, platform: Platform, argv: string[], cwd: string, label: string, onEnd?: (ok: boolean) => void) {
  void (async () => {
    let tail = ''
    let ok = false
    try {
      const stream = $.process.spawn({ argv, cwd, env: childEnv(platform) })
      for await (const piece of stream) tail = (tail + piece.text).slice(-1500)
      const end = await stream.result
      ok = end.code === 0
      debug($, ok ? `${label} in ${cwd} done` : `${label} in ${cwd} ended with ${end.code ?? end.signal}: ${tail.trim()}`)
    } catch (err) {
      debug($, `${label} in ${cwd} did not run: ${String(err)}`)
    }
    try {
      onEnd?.(ok)
    } catch {
      // A reporting failure changes nothing about the index.
    }
  })().catch(() => undefined)
}

/**
 * Starts a long codegraph run (init, a repair) so it outlives the session on
 * POSIX, where an index of a large repository takes minutes. On Windows it
 * runs with the session; a run cut short is finished by a later one.
 */
async function startLong($: $, platform: Platform, argv: string[], cwd: string, label: string): Promise<boolean> {
  if (isWindows(platform)) {
    runInBackground($, platform, argv, cwd, label)
    return true
  }
  const r = await $.process.run(detachedArgv(argv), { cwd, timeoutMs: 10_000 }).catch((err) => {
    debug($, `${label} in ${cwd} did not start: ${String(err)}`)
    return undefined
  })
  if (r && r.exitCode === 0) debug($, `${label} started in ${cwd}`)
  return r?.exitCode === 0
}

async function heldSince($: $, key: string, holdMs: number): Promise<boolean> {
  const at = Number((await $.store.get(key).catch(() => undefined)) ?? 0)
  return at > 0 && (await $.clock.now()) - at < holdMs
}

async function hold($: $, key: string) {
  await $.store.set(key, await $.clock.now()).catch(() => undefined)
}

async function startInit($: $, root: string, platform: Platform, tools: Tooling, isLinked: boolean, why: string): Promise<Outcome> {
  if (!config.autoInit) return { kind: 'left-alone', root, isLinked, why: 'autoInit is off' }
  const unsafe = unsafeRootReason(root, await homeOf($), platform)
  if (unsafe) return { kind: 'left-alone', root, isLinked, why: unsafe }
  const argv = codegraphArgv(tools, platform, ['init', '-y'])
  if (!argv) return { kind: 'left-alone', root, isLinked, why: 'cannot start codegraph safely from this install' }
  // One init per tree per day, across sessions: a run another session
  // started may still be going, and one that fails would only fail again.
  const key = `init:${pathKey(root, platform)}`
  if (await heldSince($, key, INIT_HOLD_MS)) return { kind: 'left-alone', root, isLinked, why: 'codegraph init ran here recently' }
  await hold($, key)
  if (!(await startLong($, platform, argv, root, 'codegraph init'))) {
    return { kind: 'left-alone', root, isLinked, why: 'codegraph init did not start' }
  }
  return { kind: 'initializing', root, isLinked, why }
}

/** Brings a copied index to this tree's branch, then marks it done. */
function startSync($: $, root: string, platform: Platform, tools: Tooling, dirName: string) {
  const key = pathKey(root, platform)
  const argv = codegraphArgv(tools, platform, ['sync'])
  if (!argv || syncing.has(key)) return
  syncing.add(key)
  runInBackground($, platform, argv, root, 'codegraph sync', (ok) => {
    syncing.delete(key)
    if (ok) void $.fs.write(joinPath(root, dirName, SYNC_MARKER), 'done\n').catch(() => undefined)
  })
}

/** A copy whose sync never finished (the session that made it ended first). */
async function needsSync($: $, root: string, dirName: string): Promise<boolean> {
  const text = await $.fs.read(joinPath(root, dirName, SYNC_MARKER)).catch(() => undefined)
  return text?.trim() === 'pending'
}

/** How an index stands, read by the clone script's probe; null when it cannot tell. */
async function probeIndex($: $, platform: Platform, tools: Tooling, indexDir: string) {
  if (!tools.node) return null
  const script = joinPath($.plugin.root, 'scripts', 'clone-index.mjs')
  const r = await $.process.run([tools.node, script, '--probe', indexDir], { timeoutMs: 20_000, env: childEnv(platform) }).catch(() => undefined)
  return r ? parseProbe(r.stdout) : null
}

/**
 * Once per tree per process: rebuild an index a run left unfinished or
 * unreadable (an init killed with the session, a reboot mid-index). Never
 * while CodeGraph is writing it; at most every few hours per tree.
 */
function checkHealth($: $, root: string, platform: Platform, tools: Tooling, dirName: string) {
  const key = pathKey(root, platform)
  if (healthChecked.has(key)) return
  healthChecked.add(key)
  void (async () => {
    const probe = await probeIndex($, platform, tools, joinPath(root, dirName))
    if (!probe || !needsRebuild(probe)) return
    const holdKey = `repair:${key}`
    if (await heldSince($, holdKey, REPAIR_HOLD_MS)) return
    const argv = codegraphArgv(tools, platform, ['index', '-q'])
    if (!argv) return
    debug($, `index in ${root} is ${probe.broken ? 'unreadable' : probe.state}; rebuilding it with codegraph index`)
    if (await startLong($, platform, argv, root, 'codegraph index (repair)')) await hold($, holdKey)
  })().catch((err) => debug($, `health check in ${root} failed: ${String(err)}`))
}

/** Copies an index from another worktree; null when none could be placed. */
/**
 * Copies an index from another worktree. 'busy': a source is being written,
 * try again later; 'failed': a copy went wrong; null: no usable source (none
 * indexed, or none finished), so this tree needs its own init.
 */
async function tryCopy($: $, root: string, gitDir: string, platform: Platform, tools: Tooling, dirName: string): Promise<Outcome | 'busy' | 'failed' | null> {
  // No sync to bring a copy to this branch: a copy would stay on another's.
  if (!codegraphArgv(tools, platform, ['sync'])) return null
  if (!tools.node) {
    debug($, 'no Node runtime found next to codegraph or on PATH; cannot copy an index')
    return null
  }
  const list = await git($, platform, root, ['worktree', 'list', '--porcelain'])
  if (list === null) return null
  const script = joinPath($.plugin.root, 'scripts', 'clone-index.mjs')
  const home = await homeOf($)
  for (let attempt = 0; attempt <= COPY_RETRIES; attempt++) {
    if (attempt > 0) await $.clock.sleep(COPY_RETRY_DELAY_MS)
    let busy = false
    let failed = false
    for (const source of sourceCandidates(parseWorktreeList(list), root, platform)) {
      if (unsafeRootReason(source, home, platform)) continue
      const sourceIndex = joinPath(source, dirName)
      if (!(await $.fs.exists(joinPath(sourceIndex, 'codegraph.db')))) continue
      const r = await $.process
        .run([tools.node, script, sourceIndex, root, dirName, gitDir], { timeoutMs: COPY_TIMEOUT_MS, env: childEnv(platform) })
        .catch((err) => ({ exitCode: -1, stdout: JSON.stringify({ status: 'failed', reason: String(err) }), stderr: '' }))
      const report = parseCloneReport(r.stdout)
      if (report.status === 'copied') {
        startSync($, root, platform, tools, dirName)
        return { kind: 'copied', root, from: source, method: report.method ?? 'copy' }
      }
      if (report.status === 'exists') return { kind: 'ready', root, isLinked: true }
      if (report.status === 'skipped' && !report.unfinished) busy = true
      if (report.status === 'failed') failed = true
      debug($, `copy from ${source} ${report.status}: ${report.reason ?? ''}`)
    }
    if (!busy) return failed ? 'failed' : null
  }
  return 'busy'
}

async function ensureRoot($: $, root: string, gitDir: string, isLinked: boolean, platform: Platform): Promise<Outcome> {
  const dirName = indexDirName(await $.env.get('CODEGRAPH_DIR'))
  if (!dirName) return { kind: 'left-alone', root, isLinked, why: 'CODEGRAPH_DIR is not a plain folder name' }
  if (platform === 'wsl' && /^\/mnt\/[a-z](\/|$)/i.test(root)) {
    // CodeGraph keeps a separate index folder there; leave it to CodeGraph.
    return { kind: 'left-alone', root, isLinked, why: 'a Windows drive under WSL' }
  }
  const indexDir = joinPath(root, dirName)

  if (await $.fs.exists(joinPath(indexDir, 'codegraph.db'))) {
    const tools = await toolingOf($, platform)
    if (tools) {
      if (isLinked && (await needsSync($, root, dirName))) startSync($, root, platform, tools, dirName)
      else checkHealth($, root, platform, tools, dirName)
    }
    return { kind: 'ready', root, isLinked }
  }
  const tools = await toolingOf($, platform)
  if (!tools) return { kind: 'not-installed' }
  // A folder with anything but a committed .gitignore in it: an init under
  // way, or one a person is dealing with. Either way it is not ours to touch.
  if (await $.fs.exists(indexDir)) {
    const names = await $.fs
      .list(indexDir)
      .then((entries) => entries.map((e) => e.name))
      .catch(() => null)
    if (!names || !isEmptyIndexDir(names)) {
      return { kind: 'left-alone', root, isLinked, why: `${dirName} exists without a database` }
    }
  }

  if (isLinked && config.copyIntoWorktrees) {
    const copied = await tryCopy($, root, gitDir, platform, tools, dirName)
    if (copied === 'busy') return { kind: 'left-alone', root, isLinked, why: 'the source index is busy; trying again next session' }
    if (copied === 'failed') {
      // A copy can fail for passing reasons (a full disk, a timeout): try it
      // again next session, and index from scratch only when it fails twice.
      const key = `copy-failed:${pathKey(root, platform)}`
      if (!(await heldSince($, key, INIT_HOLD_MS))) {
        await hold($, key)
        return { kind: 'left-alone', root, isLinked, why: 'the copy failed; trying again next session' }
      }
      return startInit($, root, platform, tools, isLinked, 'copying an index failed twice')
    }
    if (copied) return copied
    return startInit($, root, platform, tools, isLinked, 'no index to copy from another worktree')
  }
  return startInit($, root, platform, tools, isLinked, 'repository not indexed yet')
}

/** How far a check has got: the tree, once git has named it. */
type Progress = { root?: string; isLinked?: boolean }

async function ensureIndexAt($: $, dir: string, progress: Progress): Promise<Outcome> {
  const platform = await platformOf($)
  const rev = await git($, platform, dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'])
  const place = rev === null ? null : parseRevParse(rev, dir)
  if (!place) return { kind: 'not-git' }
  const isLinked = isLinkedWorktree(place, platform)
  progress.root = place.root
  progress.isLinked = isLinked
  // One check per tree at a time, however many events and folders ask.
  const key = pathKey(place.root, platform)
  const running = byRoot.get(key)
  if (running) return running
  const p = ensureRoot($, place.root, place.gitDir, isLinked, platform).finally(() => byRoot.delete(key))
  byRoot.set(key, p)
  return p
}

function ensureIndex($: $, dir: string, progress: Progress = {}): Promise<Outcome> {
  const running = byDir.get(dir)
  if (running) return running
  const p = ensureIndexAt($, dir, progress)
    .catch((err): Outcome => {
      debug($, `checking ${dir} failed: ${String(err)}`)
      return { kind: 'not-git' }
    })
    .finally(() => byDir.delete(dir))
  byDir.set(dir, p)
  return p
}

/** The outcome, or `pending` once the budget runs out (the work runs on). */
async function ensureWithin($: $, dir: string, ms: number, loop = 'main'): Promise<Outcome> {
  const progress: Progress = {}
  let timedOut = false
  const work = ensureIndex($, dir, progress)
  const timer = $.clock.sleep(ms).then((): Outcome => {
    timedOut = true
    // Name a tree only once git has said which one it is.
    return progress.root ? { kind: 'pending', root: progress.root, isLinked: progress.isLinked ?? false } : { kind: 'not-git' }
  })
  const outcome = await Promise.race([work, timer])
  if (timedOut && loop !== 'main') void work.then((o) => tell($, o)).catch(() => undefined)
  if (timedOut && loop === 'main') {
    // The hook already said "still being checked"; say how it came out.
    void work
      .then(async (o) => {
        await tell($, o)
        const linked = linkedRoot(o)
        if (linked) toldProjectPath.set('main', linked)
        noteForNextPrompt =
          contextFor(o) ??
          (progress.isLinked ? `codegraph-worktree: no CodeGraph index could be prepared for this worktree (${progress.root}) yet; codegraph tools answer from another tree's index or none.` : null)
      })
      .catch(() => undefined)
  }
  return outcome
}

/** Tells the person; false when an install reminder is not due. */
async function tell($: $, outcome: Outcome): Promise<boolean> {
  try {
    const notice = noticeFor(outcome)
    if (notice) $.ui.toast(notice, { timeoutMs: 6000 })
    if (outcome.kind === 'not-installed') {
      if (await heldSince($, 'recommended', RECOMMEND_EVERY_MS)) return false
      await hold($, 'recommended')
      $.ui.log('codegraph-worktree: CodeGraph is not installed. See https://github.com/colbymchenry/codegraph to install it.')
    }
  } catch (err) {
    debug($, `telling the person failed: ${String(err)}`)
  }
  return true
}

/** The model-facing text for an outcome, after the person has been told. */
async function report($: $, outcome: Outcome): Promise<string | null> {
  const shouldSay = await tell($, outcome)
  if (outcome.kind === 'not-installed' && !shouldSay) return null
  const linked = linkedRoot(outcome)
  if (linked) toldProjectPath.set('main', linked)
  return contextFor(outcome)
}

function withContext<R extends { additionalContext?: string[] }>(result: R, text: string | null): R {
  return text ? { ...result, additionalContext: [...(result.additionalContext ?? []), text] } : result
}

/** After a move: say what to pass now, or to stop passing the old worktree. */
async function reportMove($: $, dir: string, loop: string): Promise<string | null> {
  const before = toldProjectPath.get(loop) ?? null
  const outcome = await ensureWithin($, dir, START_BUDGET_MS)
  await tell($, outcome)
  const linked = linkedRoot(outcome)
  if (linked) {
    toldProjectPath.set(loop, linked)
    return contextFor(outcome)
  }
  toldProjectPath.delete(loop)
  return movedContext(outcome, before)
}

/** A hook that fails, misreturns or overruns leaves the event as it would be without this plugin. */
const passThrough = <E, R>(_$: $, e: E, next: (e: E) => Promise<R>) => next(e)

export const register: Register = (on, options) => {
  config.autoInit = options.autoInit !== false
  config.copyIntoWorktrees = options.copyIntoWorktrees !== false

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const outcome = await ensureWithin($, e.cwd, START_BUDGET_MS)
    return withContext(result, await report($, outcome))
  }).catch(passThrough)

  // EnterWorktree and ExitWorktree move the session: check the tree it lands
  // in, and tell the model which index to ask.
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (e.tool_name !== 'EnterWorktree' && e.tool_name !== 'ExitWorktree') return result
    const response = e.tool_response as { worktreePath?: unknown } | undefined
    const dir =
      e.tool_name === 'EnterWorktree' && typeof response?.worktreePath === 'string'
        ? response.worktreePath
        : await $.session.cwd().catch(() => e.cwd)
    const loop = typeof (e as { agent_id?: unknown }).agent_id === 'string' ? (e as { agent_id: string }).agent_id : 'main'
    return withContext(result, await reportMove($, dir, loop))
  }).catch(passThrough)

  // /cd, a host's directory change: this event cannot carry context, so what
  // the model should know waits for the next prompt.
  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    // Bounded by the same budget as the other hooks; the work runs on after it.
    noteForNextPrompt = await reportMove($, e.new_cwd, 'main').catch(() => null)
    return result
  }).catch(passThrough)

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    const note = noteForNextPrompt
    noteForNextPrompt = null
    return withContext(result, note)
  }).catch(passThrough)

  // A subagent: in its own worktree (`isolation: "worktree"`), or in this
  // session's. Its context does not carry the session start's, so say it again.
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    const outcome = await ensureWithin($, e.cwd, START_BUDGET_MS, e.agent_id)
    if (!linkedRoot(outcome)) return result
    void tell($, outcome).catch(() => undefined)
    return withContext(result, contextFor(outcome))
  }).catch(passThrough)
}
