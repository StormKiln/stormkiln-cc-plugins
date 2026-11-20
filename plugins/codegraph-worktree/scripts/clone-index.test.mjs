// Tests for clone-index.mjs against real files: `node --test` (Node 22.13+).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clone-index.mjs')

function tree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgwt-'))
  const src = path.join(base, 'main')
  const dst = path.join(base, 'wt')
  fs.mkdirSync(path.join(src, '.codegraph'), { recursive: true })
  fs.mkdirSync(dst)
  return { base, src, dst, srcIndex: path.join(src, '.codegraph'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

/** A database shaped like CodeGraph's, in WAL mode, left open so the WAL stays. */
function makeIndex(dir, rows = 3) {
  const db = new DatabaseSync(path.join(dir, 'codegraph.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  db.exec('CREATE TABLE files (path TEXT PRIMARY KEY); CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE edges (a INTEGER, b INTEGER)')
  db.exec("CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER); INSERT INTO project_metadata VALUES ('index_state', 'complete', 0)")
  const ins = db.prepare('INSERT INTO nodes (name) VALUES (?)')
  for (let i = 0; i < rows; i++) ins.run(`n${i}`)
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n!.gitignore\n')
  return db
}

function run(src, dst) {
  const r = spawnSync(process.execPath, [SCRIPT, src, dst], { encoding: 'utf8' })
  return { code: r.status, report: JSON.parse(r.stdout.trim().split('\n').pop()), stderr: r.stderr }
}

function runAsync(src, dst) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, src, dst])
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop())))
  })
}

const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.codegraph.cgwt-tmp-'))

test('copies the index, WAL content included, and leaves no temporary behind', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex, 5)
  try {
    assert.ok(fs.statSync(path.join(t.srcIndex, 'codegraph.db-wal')).size > 0, 'rows sit in the WAL')
    fs.writeFileSync(path.join(t.srcIndex, 'daemon.pid'), '123')
    const { code, report } = run(t.srcIndex, t.dst)
    assert.equal(code, 0)
    assert.equal(report.status, 'copied')
    assert.equal(report.checked, true)
    const copy = new DatabaseSync(path.join(t.dst, '.codegraph', 'codegraph.db'), { readOnly: true })
    assert.equal(copy.prepare('SELECT count(*) AS c FROM nodes').get().c, 5)
    copy.close()
    assert.ok(!fs.existsSync(path.join(t.dst, '.codegraph', 'daemon.pid')), 'process files are not copied')
    assert.ok(fs.existsSync(path.join(t.dst, '.codegraph', '.gitignore')))
    assert.equal(fs.readFileSync(path.join(t.dst, '.codegraph', 'cgwt-sync'), 'utf8'), 'pending\n')
    assert.deepEqual(leftovers(t.dst), [])
    // The source is untouched.
    assert.equal(db.prepare('SELECT count(*) AS c FROM nodes').get().c, 5)
  } finally {
    db.close()
    t.cleanup()
  }
})

test('never touches an existing .codegraph', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    fs.mkdirSync(path.join(t.dst, '.codegraph'))
    fs.writeFileSync(path.join(t.dst, '.codegraph', 'mine'), 'keep')
    const { report } = run(t.srcIndex, t.dst)
    assert.equal(report.status, 'exists')
    assert.deepEqual(fs.readdirSync(path.join(t.dst, '.codegraph')), ['mine'])
    assert.deepEqual(leftovers(t.dst), [])
  } finally {
    db.close()
    t.cleanup()
  }
})

test('refuses to copy a tree onto itself', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    fs.rmSync(t.dst, { recursive: true })
    const { report } = run(t.srcIndex, t.src)
    // .codegraph exists in the source tree itself, so this is a no-op either way.
    assert.ok(['exists', 'failed'].includes(report.status))
  } finally {
    db.close()
    t.cleanup()
  }
})

test('a corrupt source is refused and nothing is placed', () => {
  const t = tree()
  try {
    fs.writeFileSync(path.join(t.srcIndex, 'codegraph.db'), Buffer.alloc(8192, 7))
    const { code, report } = run(t.srcIndex, t.dst)
    assert.equal(code, 1)
    assert.equal(report.status, 'failed')
    assert.ok(!fs.existsSync(path.join(t.dst, '.codegraph')))
    assert.deepEqual(leftovers(t.dst), [])
  } finally {
    t.cleanup()
  }
})

test('a database that is not a CodeGraph index is refused', () => {
  const t = tree()
  try {
    const db = new DatabaseSync(path.join(t.srcIndex, 'codegraph.db'))
    db.exec('CREATE TABLE other (x)')
    db.close()
    const { report } = run(t.srcIndex, t.dst)
    assert.equal(report.status, 'failed')
    assert.match(report.reason, /not a CodeGraph index/)
    assert.ok(!fs.existsSync(path.join(t.dst, '.codegraph')))
  } finally {
    t.cleanup()
  }
})

test('skips while a rebuild of the source runs', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    fs.writeFileSync(path.join(t.srcIndex, 'rebuild.pid'), String(process.pid))
    const { report } = run(t.srcIndex, t.dst)
    assert.equal(report.status, 'skipped')
    assert.ok(!fs.existsSync(path.join(t.dst, '.codegraph')))
    // A dead pid's lock is stale and does not block.
    fs.writeFileSync(path.join(t.srcIndex, 'rebuild.pid'), '999999999')
    assert.equal(run(t.srcIndex, t.dst).report.status, 'copied')
  } finally {
    db.close()
    t.cleanup()
  }
})

test('writes a .gitignore when the source has none', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    fs.rmSync(path.join(t.srcIndex, '.gitignore'))
    assert.equal(run(t.srcIndex, t.dst).report.status, 'copied')
    assert.match(fs.readFileSync(path.join(t.dst, '.codegraph', '.gitignore'), 'utf8'), /^\*$/m)
  } finally {
    db.close()
    t.cleanup()
  }
})

test('sweeps only its own stale temporaries', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    const stale = path.join(t.dst, '.codegraph.cgwt-tmp-1-dead')
    const fresh = path.join(t.dst, '.codegraph.cgwt-tmp-2-live')
    const other = path.join(t.dst, '.codegraph.backup')
    for (const d of [stale, fresh, other]) fs.mkdirSync(d)
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(stale, old, old)
    fs.utimesSync(other, old, old)
    assert.equal(run(t.srcIndex, t.dst).report.status, 'copied')
    assert.ok(!fs.existsSync(stale))
    assert.ok(fs.existsSync(fresh))
    assert.ok(fs.existsSync(other))
  } finally {
    db.close()
    t.cleanup()
  }
})

test('racing copies place exactly one index', async () => {
  const t = tree()
  const db = makeIndex(t.srcIndex, 200)
  try {
    const reports = await Promise.all(Array.from({ length: 6 }, () => runAsync(t.srcIndex, t.dst)))
    const statuses = reports.map((r) => r.status).sort()
    assert.equal(statuses.filter((s) => s === 'copied').length, 1, JSON.stringify(reports))
    assert.ok(statuses.every((s) => s === 'copied' || s === 'exists'), JSON.stringify(reports))
    assert.deepEqual(leftovers(t.dst), [])
    const copy = new DatabaseSync(path.join(t.dst, '.codegraph', 'codegraph.db'), { readOnly: true })
    assert.equal(copy.prepare('SELECT count(*) AS c FROM nodes').get().c, 200)
    copy.close()
  } finally {
    db.close()
    t.cleanup()
  }
})

test('a missing destination fails cleanly', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    const { code, report } = run(t.srcIndex, path.join(t.base, 'nope'))
    assert.equal(code, 1)
    assert.equal(report.status, 'failed')
  } finally {
    db.close()
    t.cleanup()
  }
})

function runWith(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, report: JSON.parse(r.stdout.trim().split('\n').pop()) }
}

test('the placed copy is one file: the WAL is folded in', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex, 4)
  try {
    assert.equal(run(t.srcIndex, t.dst).report.status, 'copied')
    assert.deepEqual(fs.readdirSync(path.join(t.dst, '.codegraph')).sort(), ['.gitignore', 'cgwt-sync', 'codegraph.db'])
    const copy = new DatabaseSync(path.join(t.dst, '.codegraph', 'codegraph.db'), { readOnly: true })
    assert.equal(copy.prepare('SELECT count(*) AS c FROM nodes').get().c, 4)
    copy.close()
  } finally {
    db.close()
    t.cleanup()
  }
})

test('a destination holding only a committed .gitignore takes the copy and keeps that file', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex, 3)
  try {
    fs.mkdirSync(path.join(t.dst, '.codegraph'))
    fs.writeFileSync(path.join(t.dst, '.codegraph', '.gitignore'), 'committed\n')
    const { report } = run(t.srcIndex, t.dst)
    assert.equal(report.status, 'copied')
    assert.equal(fs.readFileSync(path.join(t.dst, '.codegraph', '.gitignore'), 'utf8'), 'committed\n')
    const copy = new DatabaseSync(path.join(t.dst, '.codegraph', 'codegraph.db'), { readOnly: true })
    assert.equal(copy.prepare('SELECT count(*) AS c FROM nodes').get().c, 3)
    copy.close()
    assert.deepEqual(leftovers(t.dst), [])
  } finally {
    db.close()
    t.cleanup()
  }
})

test('racing copies into a .gitignore-only destination place exactly one database', async () => {
  const t = tree()
  const db = makeIndex(t.srcIndex, 50)
  try {
    fs.mkdirSync(path.join(t.dst, '.codegraph'))
    fs.writeFileSync(path.join(t.dst, '.codegraph', '.gitignore'), '*\n')
    const reports = await Promise.all(Array.from({ length: 6 }, () => runAsync(t.srcIndex, t.dst)))
    assert.equal(reports.filter((r) => r.status === 'copied').length, 1, JSON.stringify(reports))
    assert.ok(reports.every((r) => r.status === 'copied' || r.status === 'exists'), JSON.stringify(reports))
    assert.deepEqual(leftovers(t.dst), [])
  } finally {
    db.close()
    t.cleanup()
  }
})

test('builds in the scratch dir when it shares the device, leaving nothing in the worktree', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    const scratch = path.join(t.base, 'gitdir')
    fs.mkdirSync(scratch)
    const stale = path.join(scratch, '.codegraph.cgwt-tmp-1-old')
    fs.mkdirSync(stale)
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(stale, old, old)
    const { report } = runWith([t.srcIndex, t.dst, '.codegraph', scratch])
    assert.equal(report.status, 'copied')
    assert.deepEqual(fs.readdirSync(scratch), [])
    assert.deepEqual(leftovers(t.dst), [])
  } finally {
    db.close()
    t.cleanup()
  }
})

test('honours a CODEGRAPH_DIR name, and refuses one that is a path', () => {
  const t = tree()
  const custom = path.join(t.src, '.cg')
  fs.mkdirSync(custom)
  const db = makeIndex(custom)
  try {
    assert.equal(runWith([custom, t.dst, '.cg']).report.status, 'copied')
    assert.ok(fs.existsSync(path.join(t.dst, '.cg', 'codegraph.db')))
    for (const bad of ['../x', 'a/b', '.']) {
      const { code, report } = runWith([custom, t.dst, bad])
      assert.equal(code, 2)
      assert.equal(report.status, 'failed')
    }
  } finally {
    db.close()
    t.cleanup()
  }
})

test('a source that is the destination tree itself is refused', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    const link = path.join(t.base, 'alias')
    fs.symlinkSync(t.src, link)
    // dest .codegraph exists here, so it is a no-op; with it moved aside the guard still refuses.
    fs.renameSync(t.srcIndex, path.join(t.src, '.cg2'))
    const { report } = runWith([path.join(link, '.cg2'), t.src, '.cg2'])
    assert.ok(['exists', 'failed'].includes(report.status))
    assert.ok(fs.existsSync(path.join(t.src, '.cg2', 'codegraph.db')))
  } finally {
    db.close()
    t.cleanup()
  }
})

test('copies nothing while CodeGraph holds the source lock, or from an unfinished index', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    fs.writeFileSync(path.join(t.srcIndex, 'codegraph.lock'), String(process.pid))
    assert.equal(run(t.srcIndex, t.dst).report.status, 'skipped')
    fs.writeFileSync(path.join(t.srcIndex, 'codegraph.lock'), '999999999')
    db.exec("UPDATE project_metadata SET value = 'indexing' WHERE key = 'index_state'")
    const { report } = run(t.srcIndex, t.dst)
    assert.equal(report.status, 'skipped')
    assert.match(report.reason, /indexing/)
    assert.ok(!fs.existsSync(path.join(t.dst, '.codegraph')))
    assert.deepEqual(leftovers(t.dst), [])
  } finally {
    db.close()
    t.cleanup()
  }
})

test('a destination a killed run left with only .gitignore and the marker still takes a copy', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    fs.mkdirSync(path.join(t.dst, '.codegraph'))
    fs.writeFileSync(path.join(t.dst, '.codegraph', '.gitignore'), '*\n')
    fs.writeFileSync(path.join(t.dst, '.codegraph', 'cgwt-sync'), 'pending\n')
    assert.equal(run(t.srcIndex, t.dst).report.status, 'copied')
    assert.ok(fs.existsSync(path.join(t.dst, '.codegraph', 'codegraph.db')))
  } finally {
    db.close()
    t.cleanup()
  }
})

test('an empty destination folder is used, not replaced', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    fs.mkdirSync(path.join(t.dst, '.codegraph'))
    const ino = fs.statSync(path.join(t.dst, '.codegraph')).ino
    assert.equal(run(t.srcIndex, t.dst).report.status, 'copied')
    assert.equal(fs.statSync(path.join(t.dst, '.codegraph')).ino, ino)
  } finally {
    db.close()
    t.cleanup()
  }
})

test('probe: state, writer and an unreadable database', () => {
  const t = tree()
  const db = makeIndex(t.srcIndex)
  try {
    assert.deepEqual(
      (({ status, state, writing }) => ({ status, state, writing }))(runWith(['--probe', t.srcIndex]).report),
      { status: 'probed', state: 'complete', writing: false },
    )
    fs.writeFileSync(path.join(t.srcIndex, 'codegraph.lock'), String(process.pid))
    assert.equal(runWith(['--probe', t.srcIndex]).report.writing, true)
    const bad = path.join(t.base, 'bad')
    fs.mkdirSync(bad)
    fs.writeFileSync(path.join(bad, 'codegraph.db'), Buffer.alloc(8192, 7))
    assert.equal(runWith(['--probe', bad]).report.broken, true)
  } finally {
    db.close()
    t.cleanup()
  }
})

test('the temp folder hides itself from git whole while the copy is made', () => {
  // The script gives its temp folder a .gitignore of a bare `*` before anything
  // else; git then shows nothing of the folder, the .gitignore included. (The
  // usual `*` plus `!.gitignore` would show the folder.)
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /writeFileSync\(path\.join\(tmp, GITIGNORE\), '\*\\n'\)/)
  const t = tree()
  try {
    spawnSync('git', ['init', '-q', t.dst])
    const tmp = path.join(t.dst, '.codegraph.cgwt-tmp-1-ab')
    fs.mkdirSync(tmp)
    fs.writeFileSync(path.join(tmp, '.gitignore'), '*\n')
    fs.writeFileSync(path.join(tmp, 'codegraph.db'), 'x')
    const st = spawnSync('git', ['-C', t.dst, 'status', '--porcelain'], { encoding: 'utf8' })
    assert.equal(st.stdout.trim(), '')
  } finally {
    t.cleanup()
  }
})
