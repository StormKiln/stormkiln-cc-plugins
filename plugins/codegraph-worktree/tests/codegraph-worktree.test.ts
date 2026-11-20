import { describe, expect, test } from 'claude-code/testing'

import {
  bundledNodeFor,
  codegraphArgv,
  contextFor,
  isLinkedWorktree,
  isUnsafeRoot,
  joinPath,
  parseCloneReport,
  parseRevParse,
  parseWorktreeList,
  pathCandidates,
  samePath,
  sourceCandidates,
} from '../hooks/logic'

describe('paths', () => {
  test('joins and normalizes POSIX and Windows paths', async () => {
    expect(joinPath('/a/b/', 'c')).toBe('/a/b/c')
    expect(joinPath('C:\\Users\\x', '.codegraph', 'codegraph.db')).toBe('C:/Users/x/.codegraph/codegraph.db')
    expect(joinPath('C:', 'x')).toBe('C:/x')
  })

  test('compares case-insensitively only where the file system does', async () => {
    expect(samePath('/Repo/A', '/repo/a/', 'macos')).toBe(true)
    expect(samePath('C:\\Repo', 'c:/repo', 'windows')).toBe(true)
    expect(samePath('/Repo/A', '/repo/a', 'linux')).toBe(false)
  })

  test('finds the bundled node beside the launcher', async () => {
    expect(bundledNodeFor('/home/u/.codegraph/versions/v1.6.4/bin/codegraph', 'linux')).toBe('/home/u/.codegraph/versions/v1.6.4/node')
    expect(bundledNodeFor('C:\\cg\\v1\\bin\\codegraph.cmd', 'windows')).toBe('C:/cg/v1/node.exe')
  })

  test('refuses home and filesystem roots', async () => {
    expect(isUnsafeRoot('/', '/home/u', 'linux')).toBe(true)
    expect(isUnsafeRoot('C:\\', undefined, 'windows')).toBe(true)
    expect(isUnsafeRoot('/home/u/', '/home/u', 'linux')).toBe(true)
    expect(isUnsafeRoot('/home/u/code/x', '/home/u', 'linux')).toBe(false)
  })
})

describe('PATH search', () => {
  test('POSIX: one candidate per directory', async () => {
    expect(pathCandidates('codegraph', '/usr/bin::/opt/bin', 'macos')).toEqual(['/usr/bin/codegraph', '/opt/bin/codegraph'])
  })

  test('Windows: only extensions the host can start, quotes stripped', async () => {
    const found = pathCandidates('codegraph', 'C:\\a;"C:\\b c"', 'windows', '.COM;.EXE;.BAT;.CMD;.PS1')
    expect(found).toEqual(['C:/a/codegraph.exe', 'C:/a/codegraph.bat', 'C:/a/codegraph.cmd', 'C:/b c/codegraph.exe', 'C:/b c/codegraph.bat', 'C:/b c/codegraph.cmd'])
  })

  test('no PATH, no candidates', async () => {
    expect(pathCandidates('codegraph', undefined, 'linux')).toEqual([])
  })
})

describe('command lines', () => {
  test('a .cmd launcher runs through cmd.exe by name, never by path', async () => {
    expect(codegraphArgv('C:/x & y/codegraph.cmd', 'windows', ['sync', '-q'])).toEqual(['cmd.exe', '/d', '/c', 'codegraph', 'sync', '-q'])
    expect(codegraphArgv('/usr/local/bin/codegraph', 'linux', ['init', '-y'])).toEqual(['/usr/local/bin/codegraph', 'init', '-y'])
  })
})

describe('git output', () => {
  test('rev-parse: main tree and linked worktree', async () => {
    const main = parseRevParse('/r\n/r/.git\n/r/.git\n')
    expect(main).toEqual({ root: '/r', gitDir: '/r/.git', commonDir: '/r/.git' })
    expect(isLinkedWorktree(main!, 'linux')).toBe(false)
    const linked = parseRevParse('/w\r\n/r/.git/worktrees/w\r\n/r/.git\r\n')
    expect(isLinkedWorktree(linked!, 'linux')).toBe(true)
    expect(parseRevParse('/r\n')).toBe(null)
  })

  test('worktree list: main first, bare and prunable skipped, self excluded', async () => {
    const list = parseWorktreeList(
      'worktree /r\nHEAD abc\nbranch refs/heads/main\n\n' +
        'worktree /w1\nHEAD def\nbranch refs/heads/a\n\n' +
        'worktree /gone\nHEAD 123\nprunable gitdir file points to non-existent location\n\n' +
        'worktree /w2\nHEAD 456\ndetached\n',
    )
    expect(list.map((w) => w.path)).toEqual(['/r', '/w1', '/gone', '/w2'])
    expect(sourceCandidates(list, '/w1', 'linux')).toEqual(['/r', '/w2'])
    expect(sourceCandidates(parseWorktreeList('worktree /bare.git\nbare\n\nworktree /w\nHEAD 1\n'), '/w', 'linux')).toEqual([])
  })
})

describe('the copy script report', () => {
  test('reads its last JSON line', async () => {
    expect(parseCloneReport('noise\n{"status":"copied","method":"clone","checked":true,"ms":4}\n')).toEqual({
      status: 'copied',
      method: 'clone',
      reason: undefined,
      checked: true,
    })
  })

  test('anything else is a failure', async () => {
    expect(parseCloneReport('').status).toBe('failed')
    expect(parseCloneReport('{"status":"weird"}').status).toBe('failed')
  })
})

describe('what the model is told', () => {
  test('nothing for an indexed main tree; projectPath for a worktree', async () => {
    expect(contextFor({ kind: 'ready', root: '/r', isLinked: false })).toBe(null)
    expect(contextFor({ kind: 'ready', root: '/w', isLinked: true })).toContain('projectPath="/w"')
    expect(contextFor({ kind: 'not-git' })).toBe(null)
    expect(contextFor({ kind: 'not-installed' })).toContain('install.sh')
  })
})

// ---- The hooks, over a fake host -------------------------------------------

/** Lets work the hooks left running in the background finish. */
async function settle() {
  for (let i = 0; i < 500; i++) await Promise.resolve()
}

type Run = { argv: readonly string[]; cwd?: string }

/** A host with one repo at /r (indexed) and a linked worktree /r-wt (not). */
function host(on: Parameters<Parameters<typeof test>[1]>[1], opts: { installed?: boolean; worktreeIndexed?: boolean } = {}) {
  const installed = opts.installed ?? true
  const files = new Set<string>(['/r/.codegraph/codegraph.db'])
  if (installed) {
    files.add('/home/u/.codegraph/versions/v1/bin/codegraph')
    files.add('/home/u/.codegraph/versions/v1/node')
  }
  if (opts.worktreeIndexed) files.add('/r-wt/.codegraph/codegraph.db')
  const runs: Run[] = []
  const spawns: Run[] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>()

  on('session.info', () => ({ value: { platform: 'linux', transcriptPath: '' } as never }))
  on('session.cwd', () => ({ value: '/r-wt' }))
  on('env.get', (_, e) => ({
    value: ({ PATH: '/usr/bin:/home/u/.local/bin', HOME: '/home/u' } as Record<string, string>)[e.name],
  }))
  on('fs.stat', (_, e) => {
    const p = e.path
    if (p === '/home/u/.local/bin/codegraph' && installed) {
      return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: '/home/u/.codegraph/versions/v1/bin/codegraph' } }
    }
    if (files.has(p)) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: p } }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || [...files].some((f) => f.startsWith(`${e.path}/`)) }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const [cmd, ...args] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (cmd === 'git' && args[0] === 'rev-parse') {
      if (e.init?.cwd === '/r') return ok('/r\n/r/.git\n/r/.git\n')
      if (e.init?.cwd === '/r-wt') return ok('/r-wt\n/r/.git/worktrees/r-wt\n/r/.git\n')
      return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
    }
    if (cmd === 'git' && args[0] === 'worktree') {
      return ok('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD 2\nbranch refs/heads/x\n')
    }
    if (cmd === '/home/u/.codegraph/versions/v1/node') {
      files.add('/r-wt/.codegraph/codegraph.db')
      return ok('{"status":"copied","method":"clone","checked":true,"ms":3}\n')
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected' } }
  })
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: e.argv, cwd: e.cwd })
    yield { stream: 'stderr' as const, text: 'done' }
    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  const texts = new Map<string, string>()
  on('fs.read', (_, e) => {
    const t = texts.get(e.path)
    if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { value: t }
  })
  on('fs.write', (_, e) => {
    texts.set(e.path, e.text)
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  // The session-start budget never runs out here; the work always wins.
  on('clock.sleep', () => new Promise<never>(() => {}))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('classic.SessionStart', () => ({}))
  return { runs, spawns, toasts, store, files, texts }
}

describe('session start', () => {
  test('copies the main index into a worktree that has none, then syncs it', async ($, on) => {
    const h = host(on)
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    const copy = h.runs.find((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node')
    expect(copy?.argv.slice(2)).toEqual(['/r/.codegraph', '/r-wt'])
    expect(String(copy?.argv[1])).toContain('scripts/clone-index.mjs')
    await settle()
    expect(h.spawns).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'sync', '-q'], cwd: '/r-wt' }])
    expect(result.additionalContext?.join('\n')).toContain('projectPath="/r-wt"')
    expect(h.toasts.join('\n')).toContain('copy-on-write')
  })

  test('leaves an indexed main tree alone and says nothing', async ($, on) => {
    const h = host(on)
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/r' } as never)
    expect(h.spawns).toEqual([])
    expect(h.runs.filter((r) => r.argv[0] !== 'git')).toEqual([])
    expect(result.additionalContext ?? []).toEqual([])
  })

  test('a worktree that already has its own index is not copied into', async ($, on) => {
    const h = host(on, { worktreeIndexed: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    expect(h.runs.some((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node')).toBe(false)
  })

  test('finishes a sync an earlier session left pending, and marks it done', async ($, on) => {
    const h = host(on, { worktreeIndexed: true })
    h.texts.set('/r-wt/.codegraph/cgwt-sync', 'pending\n')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    await settle()
    expect(h.spawns).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'sync', '-q'], cwd: '/r-wt' }])
    expect(h.texts.get('/r-wt/.codegraph/cgwt-sync')).toBe('done\n')
    await $.classic.SessionStart({ source: 'resume', cwd: '/r-wt' } as never)
    await settle()
    expect(h.spawns.length).toBe(1)
  })

  test('outside a git repository nothing runs but git', async ($, on) => {
    const h = host(on)
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/tmp/x' } as never)
    expect(h.runs.every((r) => r.argv[0] === 'git')).toBe(true)
    expect(result.additionalContext ?? []).toEqual([])
  })

  test('recommends installing CodeGraph once a day when it is missing', async ($, on) => {
    const h = host(on, { installed: false })
    h.files.delete('/r/.codegraph/codegraph.db')
    const first = await $.classic.SessionStart({ source: 'startup', cwd: '/r' } as never)
    expect(first.additionalContext?.join('\n')).toContain('not installed')
    const second = await $.classic.SessionStart({ source: 'resume', cwd: '/r' } as never)
    expect(second.additionalContext ?? []).toEqual([])
    expect(h.spawns).toEqual([])
  })

  test('indexes a repository with no index at all, in the background', async ($, on) => {
    const h = host(on)
    h.files.delete('/r/.codegraph/codegraph.db')
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/r' } as never)
    await settle()
    expect(h.spawns).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'init', '-y'], cwd: '/r' }])
    expect(result.additionalContext?.join('\n')).toContain('building')
  })

  test('a folder .codegraph without a database is left alone', async ($, on) => {
    const h = host(on)
    h.files.add('/r-wt/.codegraph/daemon.log')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    expect(h.runs.some((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node')).toBe(false)
    expect(h.spawns).toEqual([])
  })
})
