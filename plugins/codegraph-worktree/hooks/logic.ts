// Pure helpers for codegraph-worktree: no `$`, so the tests call them directly.

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

export const isWindows = (platform: Platform): boolean => platform === 'windows'

/** Windows and the default macOS volume compare names without case. */
export const foldsCase = (platform: Platform): boolean => platform === 'windows' || platform === 'macos'

/** One entry of `git worktree list --porcelain`. */
export type Worktree = {
  path: string
  isBare: boolean
  isPrunable: boolean
}

/** What `git rev-parse` says about a directory. */
export type GitPlace = {
  /** The working tree's root, absolute. */
  root: string
  /** This working tree's own git directory, absolute. */
  gitDir: string
  /** The repository's shared git directory (the main tree's `.git`), absolute. */
  commonDir: string
}

/** How one directory stands, worked out by `ensureIndex`. */
export type Outcome =
  | { kind: 'not-git' }
  | { kind: 'not-installed' }
  | { kind: 'ready'; root: string; isLinked: boolean }
  | { kind: 'copied'; root: string; from: string; method: string }
  | { kind: 'initializing'; root: string; isLinked: boolean; why: string }
  | { kind: 'pending'; root: string; isLinked: boolean }
  | { kind: 'left-alone'; root: string; isLinked: boolean; why: string }

/** The worktree an outcome is about, when it is a linked one (the model then needs its projectPath). */
export function linkedRoot(outcome: Outcome): string | null {
  if (outcome.kind === 'copied') return outcome.root
  if ('isLinked' in outcome && outcome.isLinked) return outcome.root
  return null
}

/** A `//server/share` (or `\\server\share`) path. */
export const isUncPath = (p: string): boolean => /^[\\/]{2}[^\\/]/.test(p)

/** Folds `\` to `/`, collapses repeated separators (keeping a UNC `//`) and drops a trailing one. */
export function normalizePath(p: string): string {
  const unc = isUncPath(p)
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (unc) s = `/${s}`
  while (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

export function isAbsolutePath(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || isUncPath(p)
}

export function samePath(a: string, b: string, platform: Platform): boolean {
  const x = normalizePath(a)
  const y = normalizePath(b)
  return foldsCase(platform) ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** A key for maps of trees: equal exactly when `samePath` says so. */
export function pathKey(p: string, platform: Platform): string {
  const n = normalizePath(p)
  return foldsCase(platform) ? n.toLowerCase() : n
}

export function joinPath(...parts: string[]): string {
  const kept = parts.filter((p) => p !== '')
  if (kept.length === 0) return ''
  const joined = kept.map((p, i) => (i === 0 ? p : p.replace(/^[\\/]+/, ''))).join('/')
  const out = normalizePath(joined)
  return /^[A-Za-z]:$/.test(out) ? `${out}/` : out
}

/** `rel` against `base`, with `.` and `..` worked out; an absolute `rel` stands. */
export function resolvePath(base: string, rel: string): string {
  const full = isAbsolutePath(rel) ? normalizePath(rel) : joinPath(base, rel)
  const unc = full.startsWith('//')
  const drive = /^[A-Za-z]:/.exec(full)?.[0] ?? ''
  const rest = full.slice(unc ? 2 : drive.length)
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `${unc ? '//' : drive}/${out.join('/')}`.replace(/^\/\/\/+/, '//')
}

export function dirname(p: string): string {
  const s = normalizePath(p)
  const cut = s.lastIndexOf('/')
  if (cut < 0) return '.'
  if (cut === 0) return '/'
  const head = s.slice(0, cut)
  return /^[A-Za-z]:$/.test(head) ? `${head}/` : head
}

/**
 * `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`, one
 * line each in that order, run in `cwd`. Every git since 2.13 knows these;
 * `--git-common-dir` may be relative to `cwd`. Anything that is not three
 * paths (an old git echoes a flag it does not know) reads as null.
 */
export function parseRevParse(stdout: string, cwd: string): GitPlace | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length !== 3) return null
  const [root, gitDir, commonDir] = lines as [string, string, string]
  if (lines.some((l) => l.startsWith('-'))) return null
  if (!isAbsolutePath(root) || !isAbsolutePath(gitDir)) return null
  return {
    root: normalizePath(root),
    gitDir: normalizePath(gitDir),
    commonDir: resolvePath(cwd, commonDir),
  }
}

/** A linked worktree keeps its own git directory under the common one. */
export function isLinkedWorktree(place: GitPlace, platform: Platform): boolean {
  return !samePath(place.gitDir, place.commonDir, platform)
}

/** `git worktree list --porcelain`: blocks split by blank lines, main first. */
export function parseWorktreeList(stdout: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    let path: string | undefined
    let isBare = false
    let isPrunable = false
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line === 'bare') isBare = true
      else if (line.startsWith('prunable')) isPrunable = true
    }
    if (path !== undefined && isAbsolutePath(path)) out.push({ path: normalizePath(path), isBare, isPrunable })
  }
  return out
}

/**
 * The trees worth copying an index from, in the order to try them: the main
 * working tree first, then the other linked ones as git lists them.
 */
export function sourceCandidates(worktrees: readonly Worktree[], root: string, platform: Platform): string[] {
  return worktrees
    .filter((w) => !w.isBare && !w.isPrunable && !samePath(w.path, root, platform))
    .map((w) => w.path)
}

/**
 * Every place on PATH a command of this name could be, in PATH order. Only
 * absolute PATH entries count: `.` or an empty entry would mean the
 * repository's own folder, where anyone who wrote the checkout could plant
 * a `codegraph` or `git`.
 */
export function pathCandidates(name: string, pathVar: string | undefined, platform: Platform, pathExt?: string): string[] {
  if (!pathVar) return []
  const sep = isWindows(platform) ? ';' : ':'
  const dirs = pathVar
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && isAbsolutePath(d) && !isUncPath(d))
  if (!isWindows(platform)) return dirs.map((d) => joinPath(d, name))
  // Only kinds the host can start directly or through cmd.exe.
  const allowed = new Set(['.exe', '.cmd', '.bat'])
  const exts = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => allowed.has(e))
  return dirs.flatMap((d) => exts.map((e) => joinPath(d, `${name}${e}`)))
}

/** CodeGraph's bundle: `<bundle>/bin/codegraph[.cmd]` beside `<bundle>/node[.exe]`. */
export function bundleRootFor(launcherRealPath: string): string {
  return dirname(dirname(launcherRealPath))
}

export function bundledNodeFor(launcherRealPath: string, platform: Platform): string {
  return joinPath(bundleRootFor(launcherRealPath), isWindows(platform) ? 'node.exe' : 'node')
}

export function bundledEntryFor(launcherRealPath: string): string {
  return joinPath(bundleRootFor(launcherRealPath), 'lib', 'dist', 'bin', 'codegraph.js')
}

/** How to start CodeGraph on this host, everything absolute. */
export type Tooling = {
  /** The launcher found on PATH. */
  launcher: string
  /** A Node runtime for our copy script: CodeGraph's own, else PATH's. */
  node: string | null
  /** CodeGraph's own Node and its entry script, when it is a bundle install. */
  bundle: { node: string; entry: string } | null
  /** cmd.exe by absolute path (Windows only). */
  comspec: string | null
}

/** The flags CodeGraph's own launcher gives its bundled Node. */
const BUNDLE_NODE_FLAGS = ['--liftoff-only', '--disable-warning=ExperimentalWarning', '--max-semi-space-size=16']

/** Characters cmd.exe gives meaning to on its command line. */
const CMD_META = /["&|<>^%!()\r\n]/

/**
 * The argument vector that runs `codegraph <args>`, or null when it cannot be
 * started safely. On Windows a bundle install runs its own node.exe on its
 * entry script, with no cmd.exe at all; a `.cmd` shim (an npm install) runs
 * through cmd.exe named by absolute path, its own absolute path checked for
 * anything cmd.exe would parse. Every `args` value here is a fixed word.
 */
export function codegraphArgv(tools: Tooling, platform: Platform, args: readonly string[]): string[] | null {
  if (!isWindows(platform)) return [tools.launcher, ...args]
  if (tools.bundle) return [tools.bundle.node, ...BUNDLE_NODE_FLAGS, tools.bundle.entry, ...args]
  if (/\.exe$/i.test(tools.launcher)) return [tools.launcher, ...args]
  if (!tools.comspec || CMD_META.test(tools.launcher)) return null
  return [tools.comspec, '/d', '/c', tools.launcher, ...args]
}

/** Runs `argv` so it outlives the session (POSIX): `sh` starts it and exits. */
export function detachedArgv(argv: readonly string[]): string[] {
  return ['/bin/sh', '-c', 'nohup "$@" </dev/null >/dev/null 2>&1 &', 'sh', ...argv]
}

/** cmd.exe by absolute path: %ComSpec% when it is one, else %SystemRoot%\System32. */
export function comspecFor(comspec: string | undefined, systemRoot: string | undefined): string | null {
  if (comspec && isAbsolutePath(comspec) && /[\\/]cmd\.exe$/i.test(comspec) && !isUncPath(comspec)) return comspec
  if (systemRoot && isAbsolutePath(systemRoot) && !isUncPath(systemRoot)) return `${systemRoot.replace(/[\\/]+$/, '')}\\System32\\cmd.exe`
  return null
}

/** The folder name CodeGraph keeps its index in, after `CODEGRAPH_DIR`; null when that is invalid. */
export function indexDirName(env: string | undefined): string | null {
  const raw = env?.trim()
  if (!raw) return '.codegraph'
  if (raw === '.' || raw.includes('..') || raw.includes('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw)) return null
  return raw
}

// What CodeGraph itself refuses to index, or its MCP server to serve
// (directory.js unsafeIndexRootReason, utils.js sensitiveDirectoryRefusal).
const SENSITIVE_PATHS = new Set([
  '/', '/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/proc', '/sys',
  '/root', '/boot', '/lib', '/lib64', '/opt', '/private/tmp', '/private/var', '/private/etc',
  'c:/', 'c:/windows', 'c:/windows/system32',
])
const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.config']

/** Why CodeGraph should not be run in `root`, or null. */
export function unsafeRootReason(root: string, home: string | undefined, platform: Platform): string | null {
  const r = pathKey(root, platform)
  if (r === '/' || /^[a-z]:\/?$/i.test(r) || SENSITIVE_PATHS.has(r.toLowerCase())) return 'a system directory'
  if (isUncPath(root)) return 'a network path'
  if (platform === 'wsl' && /^\/mnt\/[a-z](\/|$)/i.test(r)) return 'a Windows drive under WSL'
  if (!home) return null
  const h = pathKey(home, platform)
  if (r === h) return 'the home directory'
  if (h.startsWith(`${r}/`)) return 'a parent of the home directory'
  for (const d of SENSITIVE_HOME_DIRS) {
    const tree = pathKey(joinPath(home, d), platform)
    if (r === tree || r.startsWith(`${tree}/`)) return `inside ~/${d}`
  }
  return null
}

/**
 * Entries an index folder may hold before it holds an index: a committed
 * `.gitignore`, and the marker a copy that was cut short left.
 */
export function isEmptyIndexDir(names: readonly string[]): boolean {
  return names.every((n) => n === '.gitignore' || n === 'cgwt-sync')
}

/** The clone script's one JSON line. */
export type CloneReport = {
  status: 'copied' | 'exists' | 'skipped' | 'failed'
  method?: string
  reason?: string
  checked?: boolean
}

export function parseCloneReport(stdout: string): CloneReport {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  try {
    const value: unknown = JSON.parse(line)
    if (value && typeof value === 'object' && 'status' in value) {
      const v = value as Record<string, unknown>
      if (v.status === 'copied' || v.status === 'exists' || v.status === 'skipped' || v.status === 'failed') {
        return {
          status: v.status,
          method: typeof v.method === 'string' ? v.method : undefined,
          reason: typeof v.reason === 'string' ? v.reason : undefined,
          checked: typeof v.checked === 'boolean' ? v.checked : undefined,
        }
      }
    }
  } catch {
    // Fall through.
  }
  return { status: 'failed', reason: `unreadable output: ${line.slice(0, 200)}` }
}

/** What `codegraph status --json` says about an index's last run, or null. */
export type IndexHealth = { projectPath: string; state: string; rebuildInProgress: boolean }

export function parseStatus(stdout: string): IndexHealth | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>
    const index = (d.index ?? {}) as Record<string, unknown>
    if (typeof d.projectPath !== 'string' || typeof index.state !== 'string') return null
    return { projectPath: d.projectPath, state: index.state, rebuildInProgress: d.rebuildInProgress === true }
  } catch {
    return null
  }
}

/** A run that was killed, dropped files or failed: `codegraph sync` finishes it. */
export const isUnfinished = (h: IndexHealth): boolean =>
  !h.rebuildInProgress && (h.state === 'indexing' || h.state === 'partial' || h.state === 'failed')

export const INSTALL_HINT =
  'Install it with `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | bash` ' +
  '(Windows PowerShell: `irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex`, ' +
  'or `npm install -g @colbymchenry/codegraph`), then run `codegraph install` to connect it to Claude Code.'

/** Text for the model about the directory it is working in; null for nothing to say. */
export function contextFor(outcome: Outcome): string | null {
  switch (outcome.kind) {
    case 'not-installed':
      return `codegraph-worktree: CodeGraph is not installed, so this repository has no code index. Recommend it to the user once: ${INSTALL_HINT}`
    case 'copied':
      return (
        `codegraph-worktree: this git worktree had no CodeGraph index, so one was copied from ${outcome.from} ` +
        `and is syncing to this branch. Pass projectPath="${outcome.root}" to codegraph tools so results come from this worktree's own index.`
      )
    case 'initializing':
    case 'pending':
      return outcome.isLinked
        ? `codegraph-worktree: a CodeGraph index for this worktree is being built at ${outcome.root}. Pass projectPath="${outcome.root}" to codegraph tools; until it is ready they may answer from another tree or not at all.`
        : `codegraph-worktree: CodeGraph is building this repository's index in the background (${outcome.root}); codegraph tools may be incomplete for a few minutes.`
    case 'ready':
      return outcome.isLinked
        ? `codegraph-worktree: this git worktree has its own CodeGraph index. Pass projectPath="${outcome.root}" to codegraph tools so results come from it rather than another tree's.`
        : null
    default:
      return null
  }
}

/** After the session moves to another tree: what the model should now pass. */
export function movedContext(outcome: Outcome, from: string | null): string | null {
  const said = contextFor(outcome)
  if (said) return said
  if (outcome.kind === 'ready' || outcome.kind === 'left-alone' || outcome.kind === 'not-git') {
    const where = 'root' in outcome ? ` (${outcome.root})` : ''
    return from
      ? `codegraph-worktree: the session left the worktree ${from}${where ? ` and is now in${where}` : ''}. Stop passing projectPath="${from}" to codegraph tools.`
      : null
  }
  return null
}

/** A short line for the person, or null when there is nothing worth showing. */
export function noticeFor(outcome: Outcome): string | null {
  switch (outcome.kind) {
    case 'copied':
      return `codegraph: index copied into this worktree (${outcome.method === 'clone' ? 'copy-on-write' : 'full copy'})`
    case 'initializing':
      return `codegraph: indexing ${outcome.root} in the background (${outcome.why})`
    default:
      return null
  }
}
