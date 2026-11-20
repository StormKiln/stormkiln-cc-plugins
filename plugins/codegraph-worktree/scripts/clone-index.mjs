#!/usr/bin/env node
// Copies a CodeGraph index (.codegraph/) from one git working tree into
// another, copy-on-write where the file system can, and only ever into a
// destination that has no .codegraph/ yet.
//
//   node clone-index.mjs <source .codegraph dir> <destination worktree root>
//
// Prints one JSON line on stdout: { status, method?, ms?, reason? }
//   status "copied"   the index is in place at <root>/.codegraph
//   status "exists"   <root>/.codegraph was already there (or another process
//                     placed it first); nothing was touched
//   status "skipped"  the source cannot be copied safely right now (a rebuild
//                     is running, or it never settled); nothing was written
//   status "failed"   something went wrong; anything this run wrote is removed
//
// Safety rules this script keeps:
//   - it writes only inside a temporary folder it created itself, then renames
//     that folder to <root>/.codegraph in one step; rename never replaces a
//     non-empty folder, so an existing index is never overwritten
//   - it never deletes anything it did not create (stale temporaries of its
//     own name pattern, older than an hour, are the one exception)
//   - the copy is checked by SQLite before it is placed

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
const GITIGNORE = '.gitignore'
const SYNC_MARKER = 'cgwt-sync'
const DEFAULT_GITIGNORE =
  '# CodeGraph data files: local to each machine, not for committing.\n*\n!.gitignore\n'
const MAX_ATTEMPTS = 5

const started = Date.now()

function out(result) {
  process.stdout.write(`${JSON.stringify({ ...result, ms: Date.now() - started })}\n`)
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

// clonefile(2) through the system cp: Node's own COPYFILE_FICLONE does not
// clone on macOS (libuv answers ENOSYS to the forced form and copies bytes
// for the other). `cp -c` fails rather than copying when it cannot clone.
function cloneDarwin(src, dst) {
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
      if (process.platform === 'darwin') cloneDarwin(src, dst)
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
  // Only ever a folder this run created, by its exact name.
  if (!tmp || !path.basename(tmp).startsWith(TMP_PREFIX)) return
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
}

function sweepStaleTmp(root) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(TMP_PREFIX)) continue
    const p = path.join(root, e.name)
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
    // Fold the WAL into the database so the placed copy is one file and the
    // first reader does not need to replay it.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  return { checked: true }
}

async function main() {
  const [srcArg, rootArg] = process.argv.slice(2)
  if (!srcArg || !rootArg) {
    out({ status: 'failed', reason: 'usage: clone-index.mjs <source .codegraph dir> <destination root>' })
    process.exitCode = 2
    return
  }
  const srcDir = path.resolve(srcArg)
  const root = path.resolve(rootArg)
  const dest = path.join(root, '.codegraph')
  const srcDb = path.join(srcDir, DB)
  const srcWal = path.join(srcDir, WAL)

  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`)
  if (fs.existsSync(dest)) return out({ status: 'exists' })
  if (path.resolve(path.dirname(srcDir)) === root) {
    return out({ status: 'failed', reason: 'source and destination are the same tree' })
  }
  const srcStat = fs.statSync(srcDb)
  if (!srcStat.isFile()) throw new Error(`source index is not a file: ${srcDb}`)
  if (rebuildRunning(srcDir)) return out({ status: 'skipped', reason: 'a rebuild of the source index is running' })

  sweepStaleTmp(root)

  const tmp = path.join(root, `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(tmp)
  try {
    const state = { method: undefined }
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
    // The -shm SQLite made while checking belongs to the folder's old name.
    fs.rmSync(path.join(tmp, `${DB}-shm`), { force: true })

    try {
      fs.renameSync(tmp, dest)
    } catch (err) {
      removeOwnTmp(tmp)
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EISDIR'].includes(err.code) && fs.existsSync(dest)) {
        return out({ status: 'exists' })
      }
      throw err
    }
    out({ status: 'copied', method: state.method, checked })
  } catch (err) {
    removeOwnTmp(tmp)
    throw err
  }
}

main().catch((err) => {
  out({ status: 'failed', reason: String(err?.message ?? err).slice(0, 500) })
  process.exitCode = 1
})
