// Pure helpers for codegraph-worktree: no `$`, so the tests call them directly.

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

export const isWindows = (platform: Platform): boolean => platform === 'windows'

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
  /** This working tree's own git directory. */
  gitDir: string
  /** The repository's shared git directory (the main tree's `.git`). */
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

/** Folds `\` to `/` and drops a trailing separator, so paths compare by text. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/')
  while (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

export function samePath(a: string, b: string, platform: Platform): boolean {
  const x = normalizePath(a)
  const y = normalizePath(b)
  // Windows and the default macOS volume compare names without case.
  return platform === 'windows' || platform === 'macos' ? x.toLowerCase() === y.toLowerCase() : x === y
}

export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== '')
    .map((p) => p.replace(/\\/g, '/'))
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^([A-Za-z]:)\/?/, '$1/')
  return normalizePath(joined)
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
 * `git rev-parse --path-format=absolute --show-toplevel --git-dir
 * --git-common-dir`, one path per line in that order.
 */
export function parseRevParse(stdout: string): GitPlace | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length < 3) return null
  const [root, gitDir, commonDir] = lines
  if (!root || !gitDir || !commonDir) return null
  return { root: normalizePath(root), gitDir: normalizePath(gitDir), commonDir: normalizePath(commonDir) }
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
    if (path !== undefined && path !== '') out.push({ path: normalizePath(path), isBare, isPrunable })
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

/** Every place on PATH a command of this name could be, in PATH order. */
export function pathCandidates(name: string, pathVar: string | undefined, platform: Platform, pathExt?: string): string[] {
  if (!pathVar) return []
  const sep = isWindows(platform) ? ';' : ':'
  const dirs = pathVar.split(sep).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d !== '')
  if (!isWindows(platform)) return dirs.map((d) => joinPath(d, name))
  // Only kinds the host can start directly or through cmd.exe.
  const allowed = new Set(['.exe', '.cmd', '.bat'])
  const exts = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => allowed.has(e))
  return dirs.flatMap((d) => exts.map((e) => joinPath(d, `${name}${e}`)))
}

/**
 * Where an installed CodeGraph keeps its own Node runtime, given where its
 * launcher really lives (`<bundle>/bin/codegraph`, `<bundle>/node`).
 */
export function bundledNodeFor(launcherRealPath: string, platform: Platform): string {
  return joinPath(dirname(dirname(launcherRealPath)), isWindows(platform) ? 'node.exe' : 'node')
}

/**
 * The argument vector that runs `codegraph <args>`. A `.cmd`/`.bat` launcher
 * goes through cmd.exe by name, found on PATH there, so no path a person
 * chose is ever parsed by cmd.exe; every `args` value here is a fixed word.
 */
export function codegraphArgv(launcher: string, platform: Platform, args: readonly string[]): string[] {
  if (isWindows(platform) && /\.(cmd|bat)$/i.test(launcher)) return ['cmd.exe', '/d', '/c', 'codegraph', ...args]
  return [launcher, ...args]
}

/** Folders codegraph itself will not index without --force. */
export function isUnsafeRoot(root: string, home: string | undefined, platform: Platform): boolean {
  const r = normalizePath(root)
  if (r === '/' || /^[A-Za-z]:\/?$/.test(r)) return true
  return home !== undefined && home !== '' && samePath(r, home, platform)
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
        ? `codegraph-worktree: a CodeGraph index for this worktree is being built at ${outcome.root}/.codegraph. Pass projectPath="${outcome.root}" to codegraph tools; until it is ready they may answer from another tree or not at all.`
        : `codegraph-worktree: CodeGraph is building this repository's index in the background (${outcome.root}/.codegraph); codegraph tools may be incomplete for a few minutes.`
    case 'ready':
      return outcome.isLinked
        ? `codegraph-worktree: this git worktree has its own CodeGraph index. Pass projectPath="${outcome.root}" to codegraph tools so results come from it rather than another tree's.`
        : null
    default:
      return null
  }
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
