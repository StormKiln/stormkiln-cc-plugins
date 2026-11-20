#!/usr/bin/env node
// Copies a CodeGraph index from one git working tree into another,
// copy-on-write where the file system can, and only ever into a destination
// that holds no index yet.
//
//   node clone-index.mjs <source index dir> <destination worktree root> [index dir name] [scratch dir]
//
// The index dir name is `.codegraph` unless CODEGRAPH_DIR names another. The
// scratch dir (the worktree's own git dir) is where the copy is built when it
// is on the same device as the destination, so a crash never leaves anything
// git would show; otherwise it is built beside the destination.
//
// Prints one JSON line on stdout: { status, method?, checked?, reason?, ms }
//   status "copied"   the index is in place at <root>/<index dir name>
//   status "exists"   the destination already held an index (or another
//                     process placed one first); nothing was touched
//   status "skipped"  the source cannot be copied safely right now (a rebuild
//                     is running, or it kept changing); nothing was written
//   status "failed"   something went wrong; anything this run wrote is removed
//
// Safety rules this script keeps:
//   - it writes only inside a temporary folder it created itself, and places
//     the database in one atomic step that never replaces anything (a hard
//     link, or a rename where the file system has no hard links), into a
//     destination folder that is absent or holds only a committed .gitignore
//   - it copies nothing while CodeGraph is writing the source, and nothing
//     but a finished index
//   - the source is only ever read; nothing it writes is in the source folder
//   - it never deletes anything it did not create (stale temporaries of its
//     own name pattern, older than an hour, are the one exception)
//   - the copy is checked by SQLite, and folded into one file, before it is placed

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const TMP_PREFIX = '.codegraph.cgwt-tmp-'
const STALE_TMP_MS = 60 * 60 * 1000
// Files that make up the index. The -shm file is a cache SQLite rebuilds from
// the WAL; pid, socket, lock and log files belong to the source's processes.
const DB = 'codegraph.db'
const WAL = 'codegraph.db-wal'
const SHM = 'codegraph.db-shm'
const GITIGNORE = '.gitignore'
const SYNC_MARKER = 'cgwt-sync'
const DEFAULT_GITIGNORE =
  '# CodeGraph data files: local to each machine, not for committing.\n*\n!.gitignore\n'
const MAX_ATTEMPTS = 5
// Files a destination folder may hold and still take a copy: a committed .gitignore.
// Our own marker too: a run killed after writing it must not block the next.
const EMPTY_ENOUGH = new Set([GITIGNORE, SYNC_MARKER])
const IS_WIN = process.platform === 'win32'

const started = Date.now()

function out(result) {
  process.stdout.write(`${JSON.stringify({ ...result, ms: Date.now() - started })}\n`)
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Windows refuses a rename or removal while anything (an antivirus scan, the
// search indexer) holds a file inside; it lets go within seconds.
function retryBusy(fn) {
  const until = Date.now() + (IS_WIN ? 10_000 : 0)
  for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
    try {
      return fn()
    } catch (err) {
      if (!IS_WIN || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || Date.now() > until) throw err
      sleepSync(wait)
    }
  }
}

// What a file is right now: its inode, size and mtime, plus the header bytes
// SQLite changes on every commit and checkpoint (the database's change
// counter, the WAL's checkpoint sequence and salts), so a write the clock is
// too coarse to see still shows.
function fileId(p, headerBytes) {
  let s
  try {
    s = fs.statSync(p, { bigint: true })
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent'
    throw err
  }
  let header = ''
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(headerBytes)
      const n = fs.readSync(fd, buf, 0, headerBytes, 0)
      header = buf.subarray(0, n).toString('hex')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // The stat alone, then.
  }
  return `${s.ino}:${s.size}:${s.mtimeNs}:${header}`
}
const dbId = (p) => fileId(p, 100)
const walId = (p) => fileId(p, 32)

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function heldByLiveProcess(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const match = /\d+/.exec(text)
  return match !== null && isAlive(Number(match[0]))
}

// `codegraph index` holds rebuild.pid while it rewrites the database from
// scratch; `codegraph init` and `sync` hold codegraph.lock while they index,
// init without a journal on disk. A copy taken then is a half-built index.
function indexingRunning(srcDir) {
  if (heldByLiveProcess(path.join(srcDir, 'rebuild.pid'))) return 'a rebuild of the source index is running'
  if (heldByLiveProcess(path.join(srcDir, 'codegraph.lock'))) return 'the source index is being written (codegraph.lock is held)'
  return null
}

// Whether `dir` is on an APFS volume: `cp -c` clones there and silently
// copies every byte anywhere else (exFAT, HFS+, SMB).
function isApfs(dir) {
  const df = spawnSync('/bin/df', ['-P', dir], { encoding: 'utf8', timeout: 5_000 })
  const line = df.status === 0 ? df.stdout.trim().split('\n').pop() : ''
  // Filesystem 512-blocks Used Available Capacity Mounted-on (which may hold spaces)
  const mountPoint = line?.split(/\s+/).slice(5).join(' ')
  if (!mountPoint) return false
  const mount = spawnSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5_000 })
  if (mount.status !== 0) return false
  const entry = mount.stdout.split('\n').find((l) => l.includes(` on ${mountPoint} (`))
  return /\(apfs[,)]/.test(entry ?? '')
}

// clonefile(2) through the system cp: Node's own COPYFILE_FICLONE does not
// clone on macOS (libuv answers ENOSYS to the forced form and copies bytes
// for the other).
function cloneDarwin(src, dst, state) {
  state.apfs ??= isApfs(path.dirname(dst))
  if (!state.apfs) throw Object.assign(new Error('not an APFS volume'), { code: 'ENOTSUP' })
  if (fs.existsSync(dst)) throw Object.assign(new Error(`exists: ${dst}`), { code: 'EEXIST' })
  const r = spawnSync('/bin/cp', ['-c', src, dst], { stdio: 'ignore', timeout: 60_000 })
  if (r.status !== 0) {
    fs.rmSync(dst, { force: true })
    throw Object.assign(new Error('clonefile unavailable'), { code: 'ENOTSUP' })
  }
}

// Copy-on-write first (clonefile on macOS/APFS, FICLONE on Linux btrfs/XFS),
// then an ordinary copy (on Windows CopyFileW, which block-clones on ReFS).
function copyFile(src, dst, state) {
  if (state.method !== 'copy') {
    try {
      if (process.platform === 'darwin') cloneDarwin(src, dst, state)
      else fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE)
      state.method = 'clone'
      return
    } catch (err) {
      if (err.code === 'EEXIST') throw err
      state.method = 'copy'
    }
  }
  // A full copy takes real space: keep at least as much again free after it.
  const size = BigInt(fs.statSync(src).size)
  const free = freeBytes(path.dirname(dst))
  if (free !== null && free < size * 2n) {
    throw new Error(`not enough free space for a full copy (${free} bytes free, ${size * 2n} wanted)`)
  }
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir, { bigint: true })
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

function removeOwnTmp(tmp) {
  // Only ever a folder this run created, by its exact name pattern.
  if (!tmp || !path.basename(tmp).startsWith(TMP_PREFIX)) return
  try {
    retryBusy(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))
  } catch {
    // Swept by a later run once stale.
  }
}

function sweepStaleTmp(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(TMP_PREFIX)) continue
    const p = path.join(dir, e.name)
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_TMP_MS) removeOwnTmp(p)
    } catch {
      // Another process may be removing it too.
    }
  }
}

async function verify(dbPath) {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return { checked: false }
  }
  // Read-write so SQLite replays the copied WAL into this copy alone.
  const db = new sqlite.DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    const rows = db.prepare('PRAGMA quick_check').all()
    const verdict = rows.map((r) => Object.values(r)[0]).join('; ')
    if (verdict !== 'ok') throw new Error(`quick_check: ${verdict.slice(0, 200)}`)
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    )
    for (const t of ['files', 'nodes', 'edges']) {
      if (!tables.has(t)) throw new Error(`not a CodeGraph index: no ${t} table`)
    }
    // Only a finished index is worth copying: a sync later marks a half-built
    // one complete without redoing what its run never reached.
    if (tables.has('project_metadata')) {
      const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get()
      if (row && row.value !== 'complete') {
        throw Object.assign(new Error(`the source index is ${row.value}, not complete`), { skip: true })
      }
    }
    // Fold the WAL into the database, so the copy placed is one file.
    const [cp] = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
    if (cp && Object.values(cp)[0] !== 0) throw new Error('could not fold the WAL into the copy')
  } finally {
    db.close()
  }
  return { checked: true }
}

/** Where to build the copy: the scratch dir when it shares the destination's device. */
function tmpParent(root, scratch) {
  if (!scratch) return root
  try {
    if (fs.statSync(scratch).isDirectory() && fs.statSync(scratch).dev === fs.statSync(root).dev) return scratch
  } catch {
    // Fall back to the destination's own folder.
  }
  return root
}

/** What the destination folder holds: absent, empty enough to take a copy, or taken. */
function destState(dest) {
  let names
  try {
    names = fs.readdirSync(dest)
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent'
    throw err
  }
  return names.every((n) => EMPTY_ENOUGH.has(n)) ? 'empty' : 'taken'
}

/**
 * Places the built index at `dest` without ever replacing anything; false
 * when another process got there first. The folder is made with mkdir, which
 * fails rather than take over a folder someone else just made; the database
 * then goes in by hard link, which fails rather than replace one. Until that
 * link, everything in the folder is a file that leaves it "empty enough" for
 * the next run, so a kill at any point never blocks a later copy.
 */
function place(tmp, dest) {
  try {
    fs.mkdirSync(dest)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  if (destState(dest) !== 'empty') return false
  const made = []
  const putIfAbsent = (name) => {
    try {
      fs.copyFileSync(path.join(tmp, name), path.join(dest, name), fs.constants.COPYFILE_EXCL)
      made.push(name)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
  putIfAbsent(GITIGNORE)
  putIfAbsent(SYNC_MARKER)
  const target = path.join(dest, DB)
  try {
    fs.linkSync(path.join(tmp, DB), target)
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') {
      // A file system without hard links (exFAT, some network shares):
      // rename, after one more look.
      if (!fs.existsSync(target) && !fs.existsSync(path.join(dest, WAL))) {
        retryBusy(() => fs.renameSync(path.join(tmp, DB), target))
        return true
      }
    }
    // Lost the race: take back the marker this run added, so the folder is
    // as the winner left it (a .gitignore the winner would write the same).
    if (made.includes(SYNC_MARKER)) fs.rmSync(path.join(dest, SYNC_MARKER), { force: true })
    return false
  }
}

async function main() {
  const [srcArg, rootArg, nameArg = '.codegraph', scratchArg] = process.argv.slice(2)
  if (!srcArg || !rootArg) {
    out({ status: 'failed', reason: 'usage: clone-index.mjs <source index dir> <destination root> [index dir name] [scratch dir]' })
    process.exitCode = 2
    return
  }
  if (nameArg === '.' || nameArg.includes('..') || /[\\/]/.test(nameArg) || path.isAbsolute(nameArg)) {
    out({ status: 'failed', reason: `not a plain folder name: ${nameArg}` })
    process.exitCode = 2
    return
  }
  const srcDir = path.resolve(srcArg)
  const root = path.resolve(rootArg)
  const dest = path.join(root, nameArg)
  const srcDb = path.join(srcDir, DB)
  const srcWal = path.join(srcDir, WAL)

  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`)
  if (destState(dest) === 'taken') return out({ status: 'exists' })
  // The source index sitting in the destination tree itself (a symlink, a
  // repeated path): never copy a tree onto itself.
  if (path.dirname(fs.realpathSync(srcDir)) === fs.realpathSync(root)) {
    return out({ status: 'failed', reason: 'source and destination are the same tree' })
  }
  const srcStat = fs.statSync(srcDb)
  if (!srcStat.isFile()) throw new Error(`source index is not a file: ${srcDb}`)
  const busy = indexingRunning(srcDir)
  if (busy) return out({ status: 'skipped', reason: busy })

  const parent = tmpParent(root, scratchArg ? path.resolve(scratchArg) : undefined)
  sweepStaleTmp(parent)
  if (parent !== root) sweepStaleTmp(root)

  const tmp = path.join(parent, `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(tmp)
  try {
    // First, so git never shows the copy while it is being made, even when
    // it is made beside the worktree's files.
    const srcIgnore = path.join(srcDir, GITIGNORE)
    if (fs.existsSync(srcIgnore)) fs.copyFileSync(srcIgnore, path.join(tmp, GITIGNORE))
    else fs.writeFileSync(path.join(tmp, GITIGNORE), DEFAULT_GITIGNORE)

    const state = { method: undefined, apfs: undefined }
    let settled = false
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !settled; attempt++) {
      if (attempt > 0) {
        for (const f of [DB, WAL]) fs.rmSync(path.join(tmp, f), { force: true })
        await new Promise((r) => setTimeout(r, 150 * attempt))
      }
      const before = [dbId(srcDb), walId(srcWal)]
      // WAL first: a checkpoint between the two copies then only moves pages
      // the copied WAL already holds into the copied database.
      if (before[1] !== 'absent') {
        try {
          copyFile(srcWal, path.join(tmp, WAL), state)
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
      }
      copyFile(srcDb, path.join(tmp, DB), state)
      const after = [dbId(srcDb), walId(srcWal)]
      settled = before[0] === after[0] && before[1] === after[1]
    }
    if (!settled) {
      removeOwnTmp(tmp)
      return out({ status: 'skipped', reason: 'the source index kept changing while it was copied' })
    }

    // Until `codegraph sync` has run here, the index describes the source
    // tree's branch; the mod reads this to finish the sync in a later session.
    fs.writeFileSync(path.join(tmp, SYNC_MARKER), 'pending\n')

    let checked
    try {
      ;({ checked } = await verify(path.join(tmp, DB)))
    } catch (err) {
      if (err.skip) {
        removeOwnTmp(tmp)
        return out({ status: 'skipped', reason: err.message })
      }
      throw err
    }
    // Without SQLite to fold the WAL in, the copy cannot be placed as one
    // file, and a WAL set beside a database it does not belong to corrupts it.
    if (!checked && fs.existsSync(path.join(tmp, WAL)) && fs.statSync(path.join(tmp, WAL)).size > 0) {
      removeOwnTmp(tmp)
      return out({ status: 'failed', reason: 'node:sqlite is unavailable to fold the WAL into the copy' })
    }
    // Folded into the database: what is left of the WAL, and the -shm SQLite
    // made while checking, belong to this folder alone.
    for (const f of [WAL, SHM]) fs.rmSync(path.join(tmp, f), { force: true })

    const placed = place(tmp, dest)
    removeOwnTmp(tmp)
    out(placed ? { status: 'copied', method: state.method, checked } : { status: 'exists' })
  } catch (err) {
    removeOwnTmp(tmp)
    throw err
  }
}

main().catch((err) => {
  out({ status: 'failed', reason: String(err?.message ?? err).slice(0, 500) })
  process.exitCode = 1
})
