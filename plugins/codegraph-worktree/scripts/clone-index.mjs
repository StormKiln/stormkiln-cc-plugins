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
//     the result in one atomic step that never replaces anything: a rename of
//     the whole folder when the destination is absent, or a hard link of the
//     database when the destination holds only a committed .gitignore
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
const EMPTY_ENOUGH = new Set([GITIGNORE])
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

function fileId(p) {
  try {
    const s = fs.statSync(p, { bigint: true })
    return `${s.ino}:${s.size}:${s.mtimeNs}`
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent'
    throw err
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// `codegraph index` holds rebuild.pid while it rewrites the database from
// scratch; a copy taken then is a half-built index.
function rebuildRunning(srcDir) {
  let text
  try {
    text = fs.readFileSync(path.join(srcDir, 'rebuild.pid'), 'utf8')
  } catch {
    return false
  }
  const match = /\d+/.exec(text)
  if (!match) return false
  return isAlive(Number(match[0]))
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
 * Places the built folder at `dest` without ever replacing anything. Returns
 * false when another process got there first.
 */
function place(tmp, dest) {
  if (destState(dest) === 'absent') {
    try {
      retryBusy(() => fs.renameSync(tmp, dest))
      return true
    } catch (err) {
      // POSIX rename replaces an empty folder; a non-empty one fails, as does
      // any existing one on Windows. Either way the folder is there now.
      if (!fs.existsSync(dest)) throw err
    }
  }
  if (destState(dest) !== 'empty') return false
  // A folder with only a committed .gitignore: keep it, add the index files.
  // The marker first, then the database by hard link, which fails rather
  // than replace a database another process placed meanwhile.
  try {
    fs.copyFileSync(path.join(tmp, SYNC_MARKER), path.join(dest, SYNC_MARKER), fs.constants.COPYFILE_EXCL)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  // A WAL is left only where SQLite could not fold it in; it goes first, so
  // the database is never seen without it.
  for (const f of fs.existsSync(path.join(tmp, WAL)) ? [WAL, DB] : [DB]) {
    try {
      fs.linkSync(path.join(tmp, f), path.join(dest, f))
    } catch (err) {
      if (err.code === 'EEXIST') return false
      // A file system without hard links: rename, after one more look.
      if (fs.existsSync(path.join(dest, DB)) || fs.existsSync(path.join(dest, f))) return false
      retryBusy(() => fs.renameSync(path.join(tmp, f), path.join(dest, f)))
    }
  }
  return true
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
  if (rebuildRunning(srcDir)) return out({ status: 'skipped', reason: 'a rebuild of the source index is running' })

  const parent = tmpParent(root, scratchArg ? path.resolve(scratchArg) : undefined)
  sweepStaleTmp(parent)
  if (parent !== root) sweepStaleTmp(root)

  const tmp = path.join(parent, `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(tmp)
  try {
    const state = { method: undefined, apfs: undefined }
    let settled = false
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !settled; attempt++) {
      if (attempt > 0) {
        for (const f of [DB, WAL]) fs.rmSync(path.join(tmp, f), { force: true })
        await new Promise((r) => setTimeout(r, 150 * attempt))
      }
      const before = [fileId(srcDb), fileId(srcWal)]
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
      const after = [fileId(srcDb), fileId(srcWal)]
      settled = before[0] === after[0] && before[1] === after[1]
    }
    if (!settled) {
      removeOwnTmp(tmp)
      return out({ status: 'skipped', reason: 'the source index kept changing while it was copied' })
    }

    const srcIgnore = path.join(srcDir, GITIGNORE)
    if (fs.existsSync(srcIgnore)) fs.copyFileSync(srcIgnore, path.join(tmp, GITIGNORE))
    else fs.writeFileSync(path.join(tmp, GITIGNORE), DEFAULT_GITIGNORE)

    // Until `codegraph sync` has run here, the index describes the source
    // tree's branch; the mod reads this to finish the sync in a later session.
    fs.writeFileSync(path.join(tmp, SYNC_MARKER), 'pending\n')

    const { checked } = await verify(path.join(tmp, DB))
    // Folded into the database: what is left of the WAL, and the -shm SQLite
    // made while checking, belong to this folder alone.
    if (checked) for (const f of [WAL, SHM]) fs.rmSync(path.join(tmp, f), { force: true })

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
