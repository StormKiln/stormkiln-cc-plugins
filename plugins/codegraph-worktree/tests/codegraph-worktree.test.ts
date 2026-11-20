import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  bundledNodeFor,
  codegraphArgv,
  contextFor,
  comspecFor,
  detachedArgv,
  indexDirName,
  isEmptyIndexDir,
  isLinkedWorktree,
  needsRebuild,
  joinPath,
  movedContext,
  parseCloneReport,
  parseRevParse,
  parseProbe,
  parseWorktreeList,
  pathCandidates,
  pathKey,
  resolvePath,
  samePath,
  sourceCandidates,
  unsafeRootReason,
  type Tooling,
} from '../hooks/logic'

describe('paths', () => {
  test('joins and normalizes POSIX and Windows paths', async () => {
    expect(joinPath('/a/b/', 'c')).toBe('/a/b/c')
    expect(joinPath('C:\\Users\\x', '.codegraph', 'codegraph.db')).toBe('C:/Users/x/.codegraph/codegraph.db')
    expect(joinPath('C:', 'x')).toBe('C:/x')
    expect(joinPath('//server/share/repo', '.codegraph')).toBe('//server/share/repo/.codegraph')
    expect(joinPath('\\\\server\\share', 'x')).toBe('//server/share/x')
  })

  test('resolves relative paths, dot segments included', async () => {
    expect(resolvePath('/r/sub', '../.git')).toBe('/r/.git')
    expect(resolvePath('/r', '.git')).toBe('/r/.git')
    expect(resolvePath('/r', '/abs/.git')).toBe('/abs/.git')
    expect(resolvePath('C:/r/sub', '..\\.git')).toBe('C:/r/.git')
    expect(resolvePath('//srv/share/r', '../x')).toBe('//srv/share/x')
  })

  test('map keys fold case only where the file system does', async () => {
    expect(pathKey('/A/b', 'linux')).toBe('/A/b')
    expect(pathKey('/A/b/', 'macos')).toBe('/a/b')
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

  test('refuses what CodeGraph refuses: roots, home, its parents, secrets, system folders', async () => {
    expect(unsafeRootReason('/', '/home/u', 'linux')).not.toBe(null)
    expect(unsafeRootReason('C:\\', undefined, 'windows')).not.toBe(null)
    expect(unsafeRootReason('/home/u/', '/home/u', 'linux')).not.toBe(null)
    expect(unsafeRootReason('/home', '/home/u', 'linux')).not.toBe(null)
    expect(unsafeRootReason('/home/u/.config/nvim', '/home/u', 'linux')).not.toBe(null)
    expect(unsafeRootReason('/tmp', '/home/u', 'linux')).not.toBe(null)
    expect(unsafeRootReason('//srv/share/r', undefined, 'windows')).not.toBe(null)
    expect(unsafeRootReason('/mnt/c/code/r', '/home/u', 'wsl')).not.toBe(null)
    expect(unsafeRootReason('/home/u/code/x', '/home/u', 'linux')).toBe(null)
    expect(unsafeRootReason('/home/u/.configs/x', '/home/u', 'linux')).toBe(null)
  })

  test('CODEGRAPH_DIR names the index folder; anything but a plain name is refused', async () => {
    expect(indexDirName(undefined)).toBe('.codegraph')
    expect(indexDirName(' .cg ')).toBe('.cg')
    expect(indexDirName('../x')).toBe(null)
    expect(indexDirName('a/b')).toBe(null)
  })

  test('an index folder holding only a committed .gitignore counts as empty', async () => {
    expect(isEmptyIndexDir(['.gitignore'])).toBe(true)
    expect(isEmptyIndexDir([])).toBe(true)
    expect(isEmptyIndexDir(['.gitignore', 'codegraph.lock'])).toBe(false)
  })
})

describe('PATH search', () => {
  test('POSIX: one candidate per absolute directory; relative entries are the checkout and are skipped', async () => {
    expect(pathCandidates('codegraph', '/usr/bin::/opt/bin:.:bin', 'macos')).toEqual(['/usr/bin/codegraph', '/opt/bin/codegraph'])
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
  const tools = (t: Partial<Tooling>): Tooling => ({ launcher: '', node: null, direct: null, comspec: null, ...t })

  test('POSIX runs the launcher found on PATH', async () => {
    expect(codegraphArgv(tools({ launcher: '/usr/local/bin/codegraph' }), 'linux', ['init', '-y'])).toEqual(['/usr/local/bin/codegraph', 'init', '-y'])
  })

  test('a Windows bundle runs its own node.exe on its entry script, no cmd.exe', async () => {
    const argv = codegraphArgv(tools({ launcher: 'C:/u/bin/codegraph.cmd', direct: { node: 'C:/cg/node.exe', entry: 'C:/cg/lib/dist/bin/codegraph.js', flags: ['--liftoff-only'] } }), 'windows', ['sync'])
    expect(argv?.[0]).toBe('C:/cg/node.exe')
    expect(argv?.slice(-2)).toEqual(['C:/cg/lib/dist/bin/codegraph.js', 'sync'])
  })

  test('a Windows .cmd shim goes through cmd.exe by absolute path, and only a path cmd.exe will not parse', async () => {
    const comspec = 'C:\\Windows\\System32\\cmd.exe'
    expect(codegraphArgv(tools({ launcher: 'C:/npm/codegraph.cmd', comspec }), 'windows', ['sync'])).toEqual([comspec, '/d', '/c', 'C:/npm/codegraph.cmd', 'sync'])
    expect(codegraphArgv(tools({ launcher: 'C:/x & y/codegraph.cmd', comspec }), 'windows', ['sync'])).toBe(null)
    expect(codegraphArgv(tools({ launcher: 'C:/npm/codegraph.cmd' }), 'windows', ['sync'])).toBe(null)
  })

  test('cmd.exe is named absolutely or not at all', async () => {
    expect(comspecFor('C:\\Windows\\system32\\cmd.exe', undefined)).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(comspecFor('cmd.exe', 'C:\\Windows')).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(comspecFor(undefined, undefined)).toBe(null)
  })

  test('a detached run passes its arguments to sh as arguments, not as script text', async () => {
    expect(detachedArgv(['/p/code graph', 'init', '-y'])).toEqual(['/bin/sh', '-c', 'nohup "$@" </dev/null >/dev/null 2>&1 &', 'sh', '/p/code graph', 'init', '-y'])
  })
})

describe('git output', () => {
  test('rev-parse: main tree and linked worktree', async () => {
    const main = parseRevParse('/r\n/r/.git\n.git\n', '/r')
    expect(main).toEqual({ root: '/r', gitDir: '/r/.git', commonDir: '/r/.git' })
    expect(isLinkedWorktree(main!, 'linux')).toBe(false)
    const fromSub = parseRevParse('/r\n/r/.git\n../.git\n', '/r/sub')
    expect(isLinkedWorktree(fromSub!, 'linux')).toBe(false)
    const linked = parseRevParse('/w\r\n/r/.git/worktrees/w\r\n/r/.git\r\n', '/w')
    expect(isLinkedWorktree(linked!, 'linux')).toBe(true)
    expect(parseRevParse('/r\n', '/r')).toBe(null)
  })

  test('rev-parse: an old git echoing a flag it does not know reads as no repository', async () => {
    expect(parseRevParse('--absolute-git-dir\n/r\n.git\n', '/r')).toBe(null)
    expect(parseRevParse('--path-format=absolute\n/r\n.git\n.git\n', '/r')).toBe(null)
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

describe('index health', () => {
  test('rebuild what a run left unfinished or unreadable, never while it is being written', async () => {
    const p = parseProbe('{"status":"probed","state":"indexing","writing":false,"ms":3}')
    expect(p).toEqual({ state: 'indexing', writing: false, broken: false })
    expect(needsRebuild(p!)).toBe(true)
    expect(needsRebuild({ state: 'partial', writing: false, broken: false })).toBe(true)
    expect(needsRebuild({ state: 'failed', writing: false, broken: false })).toBe(true)
    expect(needsRebuild({ state: 'unknown', writing: false, broken: true })).toBe(true)
    expect(needsRebuild({ state: 'indexing', writing: true, broken: false })).toBe(false)
    expect(needsRebuild({ state: 'complete', writing: false, broken: false })).toBe(false)
    expect(parseProbe('not json')).toBe(null)
  })
})

describe('what the model is told', () => {
  test('nothing for an indexed main tree; projectPath for a worktree', async () => {
    expect(contextFor({ kind: 'ready', root: '/r', isLinked: false })).toBe(null)
    expect(contextFor({ kind: 'ready', root: '/w', isLinked: true })).toContain('projectPath="/w"')
    expect(contextFor({ kind: 'not-git' })).toBe(null)
    expect(contextFor({ kind: 'not-installed' })).toContain('install.sh')
  })

  test('leaving a worktree retracts its projectPath', async () => {
    expect(movedContext({ kind: 'ready', root: '/r', isLinked: false }, '/w')).toContain('Stop passing projectPath="/w"')
    expect(movedContext({ kind: 'ready', root: '/r', isLinked: false }, null)).toBe(null)
  })
})

// ---- The hooks, over a fake host -------------------------------------------

/** Lets work the hooks left running in the background finish. */
async function settle() {
  for (let i = 0; i < 500; i++) await Promise.resolve()
}

type Run = { argv: readonly string[]; cwd?: string }

/** A host with one repo at /r (indexed) and a linked worktree /r-wt (not). */
function host(on: On, opts: { installed?: boolean; worktreeIndexed?: boolean } = {}) {
  const installed = opts.installed ?? true
  const files = new Set<string>(['/r/.codegraph/codegraph.db', '/usr/bin/git'])
  if (installed) {
    files.add('/home/u/.codegraph/versions/v1/bin/codegraph')
    files.add('/home/u/.codegraph/versions/v1/node')
  }
  if (opts.worktreeIndexed) files.add('/r-wt/.codegraph/codegraph.db')
  const runs: Run[] = []
  const detached: Run[] = []
  const states = new Map<string, string>()
  const cloneReply: string[] = []
  const spawns: Run[] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>()

  on('session.info', () => ({ value: { platform: 'linux', transcriptPath: '' } as never }))
  let sessionCwd = '/r-wt'
  on('session.cwd', () => ({ value: sessionCwd }))
  on('fs.list', (_, e) => ({
    value: [...files]
      .filter((f) => f.startsWith(`${e.path}/`))
      .map((f) => ({ name: f.slice(e.path.length + 1).split('/')[0]!, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
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
    const done = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    const ok = (stdout: string) => done(0, stdout)
    if (cmd === '/usr/bin/git' && args[0] === 'rev-parse') {
      if (e.init?.cwd === '/r') return ok('/r\n/r/.git\n.git\n')
      if (e.init?.cwd === '/r/src') return ok('/r\n/r/.git\n../.git\n')
      if (e.init?.cwd === '/r-wt') return ok('/r-wt\n/r/.git/worktrees/r-wt\n/r/.git\n')
      return done(128, '', 'not a git repository')
    }
    if (cmd === '/usr/bin/git' && args[0] === 'worktree') {
      return ok('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD 2\nbranch refs/heads/x\n')
    }
    if (cmd === '/home/u/.codegraph/versions/v1/node' && args[1] === '--probe') {
      const root = (args[2] ?? '').replace(/\/\.codegraph$/, '')
      return ok(JSON.stringify({ status: 'probed', state: states.get(root) ?? 'complete', writing: false }))
    }
    if (cmd === '/home/u/.codegraph/versions/v1/node' && cloneReply.length > 0) {
      return ok(`${cloneReply.shift()}\n`)
    }
    if (cmd === '/home/u/.codegraph/versions/v1/node') {
      files.add('/r-wt/.codegraph/codegraph.db')
      return ok('{"status":"copied","method":"clone","checked":true,"ms":3}\n')
    }

    if (cmd === '/bin/sh') {
      detached.push({ argv: e.argv.slice(4), cwd: e.init?.cwd })
      return ok('')
    }
    return done(1, '', 'unexpected')
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
  on('classic.SubagentStart', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.CwdChanged', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  return { runs, spawns, toasts, store, files, texts, detached, states, cloneReply, setSessionCwd: (d: string) => (sessionCwd = d) }
}

describe('session start', () => {
  test('copies the main index into a worktree that has none, then syncs it', async ($, on) => {
    const h = host(on)
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    const copy = h.runs.find((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node')
    expect(copy?.argv.slice(2)).toEqual(['/r/.codegraph', '/r-wt', '.codegraph', '/r/.git/worktrees/r-wt'])
    expect(String(copy?.argv[1])).toContain('scripts/clone-index.mjs')
    await settle()
    expect(h.spawns).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'sync'], cwd: '/r-wt' }])
    expect(result.additionalContext?.join('\n')).toContain('projectPath="/r-wt"')
    expect(h.toasts.join('\n')).toContain('copy-on-write')
  })

  test('leaves an indexed main tree alone and says nothing', async ($, on) => {
    const h = host(on)
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/r' } as never)
    await settle()
    expect(h.spawns).toEqual([])
    expect(h.detached).toEqual([])
    expect(h.runs.filter((r) => r.argv[0] !== '/usr/bin/git').map((r) => r.argv[2])).toEqual(['--probe'])
    expect(result.additionalContext ?? []).toEqual([])
  })

  test('a worktree that already has its own index is not copied into', async ($, on) => {
    const h = host(on, { worktreeIndexed: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    expect(h.runs.some((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node' && r.argv[2] !== '--probe')).toBe(false)
  })

  test('finishes a sync an earlier session left pending, and marks it done', async ($, on) => {
    const h = host(on, { worktreeIndexed: true })
    h.texts.set('/r-wt/.codegraph/cgwt-sync', 'pending\n')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    await settle()
    expect(h.spawns).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'sync'], cwd: '/r-wt' }])
    expect(h.texts.get('/r-wt/.codegraph/cgwt-sync')).toBe('done\n')
    await $.classic.SessionStart({ source: 'resume', cwd: '/r-wt' } as never)
    await settle()
    expect(h.spawns.length).toBe(1)
  })

  test('outside a git repository nothing runs but git', async ($, on) => {
    const h = host(on)
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/tmp/x' } as never)
    expect(h.runs.every((r) => r.argv[0] === '/usr/bin/git')).toBe(true)
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

  test('indexes a repository with no index at all, detached so it outlives the session, once a day', async ($, on) => {
    const h = host(on)
    h.files.delete('/r/.codegraph/codegraph.db')
    const result = await $.classic.SessionStart({ source: 'startup', cwd: '/r' } as never)
    expect(h.detached).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'init', '-y'], cwd: '/r' }])
    expect(result.additionalContext?.join('\n')).toContain('building')
    // Another session soon after: that init may still be running.
    await $.classic.SessionStart({ source: 'startup', cwd: '/r/src' } as never)
    expect(h.detached.length).toBe(1)
  })

  test('finishes an index a killed run left unfinished', async ($, on) => {
    const h = host(on)
    h.states.set('/r', 'indexing')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r' } as never)
    await settle()
    expect(h.detached).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'index', '-q'], cwd: '/r' }])
  })

  test('a partial or failed index is rebuilt too, and not again within hours', async ($, on) => {
    const h = host(on)
    h.states.set('/r', 'partial')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r' } as never)
    await settle()
    expect(h.detached.length).toBe(1)
  })

  test('a worktree whose only source is unfinished gets its own init, not nothing', async ($, on) => {
    const h = host(on)
    h.cloneReply.push('{"status":"skipped","reason":"the source index is partial, not complete","unfinished":true}')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    expect(h.detached).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'init', '-y'], cwd: '/r-wt' }])
  })

  test('a failed copy is retried next session, and only a second failure starts an init', async ($, on) => {
    const h = host(on)
    h.cloneReply.push('{"status":"failed","reason":"disk full"}', '{"status":"failed","reason":"disk full"}')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    expect(h.detached).toEqual([])
    await $.classic.SessionStart({ source: 'resume', cwd: '/r-wt' } as never)
    expect(h.detached).toEqual([{ argv: ['/home/u/.local/bin/codegraph', 'init', '-y'], cwd: '/r-wt' }])
  })

  test('a worktree that checked out a committed .codegraph/.gitignore still gets a copy', async ($, on) => {
    const h = host(on)
    h.files.add('/r-wt/.codegraph/.gitignore')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    expect(h.runs.some((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node')).toBe(true)
  })

  test('a subagent in a worktree gets the copy and the projectPath, whatever the session cwd reads', async ($, on) => {
    const h = host(on)
    h.setSessionCwd('/r-wt')
    const result = await $.classic.SubagentStart({ agent_id: 'a', agent_type: 'general-purpose', cwd: '/r-wt' } as never)
    expect(h.runs.some((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node')).toBe(true)
    expect(result.additionalContext?.join('\n')).toContain('projectPath="/r-wt"')
  })

  test('a subagent in the main tree is told nothing', async ($, on) => {
    host(on)
    const result = await $.classic.SubagentStart({ agent_id: 'a', agent_type: 'Explore', cwd: '/r' } as never)
    expect(result.additionalContext ?? []).toEqual([])
  })

  test('EnterWorktree then ExitWorktree: projectPath given, then taken back', async ($, on) => {
    const h = host(on)
    const entered = await $.classic.PostToolUse({ tool_name: 'EnterWorktree', tool_input: {}, tool_response: { worktreePath: '/r-wt' }, tool_use_id: 't1' } as never)
    expect(entered.additionalContext?.join('\n')).toContain('projectPath="/r-wt"')
    h.setSessionCwd('/r')
    const left = await $.classic.PostToolUse({ tool_name: 'ExitWorktree', tool_input: {}, tool_response: {}, tool_use_id: 't2' } as never)
    expect(left.additionalContext?.join('\n')).toContain('Stop passing projectPath="/r-wt"')
  })

  test('/cd into a worktree is reported with the next prompt', async ($, on) => {
    host(on)
    await $.classic.CwdChanged({ old_cwd: '/r', new_cwd: '/r-wt' } as never)
    await settle()
    const next = await $.classic.UserPromptSubmit({ prompt: 'hi' } as never)
    expect(next.additionalContext?.join('\n')).toContain('projectPath="/r-wt"')
    const after = await $.classic.UserPromptSubmit({ prompt: 'again' } as never)
    expect(after.additionalContext ?? []).toEqual([])
  })

  test('a folder .codegraph without a database is left alone', async ($, on) => {
    const h = host(on)
    h.files.add('/r-wt/.codegraph/daemon.log')
    await $.classic.SessionStart({ source: 'startup', cwd: '/r-wt' } as never)
    expect(h.runs.some((r) => r.argv[0] === '/home/u/.codegraph/versions/v1/node')).toBe(false)
    expect(h.spawns).toEqual([])
  })
})
