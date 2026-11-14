import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// The data folder (~/.config/jefi) holds every message in mail.db, the account list, settings and
// the attachment cache: none of it is anyone else's business on a shared Mac. Folders are made
// 0700 and files 0600 when written, and `hardenDataDir` puts right whatever an older build (or
// SQLite, or the default umask) left readable by others.
// ---------------------------------------------------------------------------

/** Folders in the data folder: only this user can list or enter them. */
export const PRIVATE_DIR_MODE = 0o700
/** Files in the data folder: only this user can read or write them. */
export const PRIVATE_FILE_MODE = 0o600

/** Deep enough for the attachment cache (attachments/<account>/<message>/<index>/<file>). */
const MAX_DEPTH = 8

/**
 * The mode a path in the data folder should have: group and others lose every bit, the owner keeps
 * theirs and can always read and write (and enter folders). A file the owner can run (the update
 * script) stays runnable; nothing else gains an execute bit.
 */
export const privateMode = (mode: number, directory: boolean) => (mode & 0o700) | (directory ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE)

/**
 * Makes `dir` and everything in it private to this user: creates it 0700 if it's missing, then
 * strips group and other access from it and from each file and folder under it. Symbolic links are
 * left alone (chmod would follow them out of the folder). Never throws: a file it can't change is
 * skipped, and nothing here may keep anyone out of their mail.
 */
export function hardenDataDir(dir: string): void {
  if (process.platform === 'win32') return
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  } catch {}
  harden(dir, 0)
}

/**
 * Before SQLite opens the database at `path`: its folder exists (0700), and the file exists 0600 so
 * the -wal and -shm files SQLite makes beside it copy that mode (SQLite creates a new database 0644
 * otherwise). An existing database, -wal and -shm lose group and other access.
 */
export function preparePrivateDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE })
  if (process.platform === 'win32') return
  try {
    // 'a' creates it empty (which SQLite takes as a new database) and never truncates one that's there.
    closeSync(openSync(path, 'a', PRIVATE_FILE_MODE))
  } catch {}
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const info = lstatSync(file)
      if (info.isFile() && (info.mode & 0o077)) chmodSync(file, privateMode(info.mode & 0o7777, false))
    } catch {}
  }
}

function harden(path: string, depth: number) {
  let info
  try {
    info = lstatSync(path)
  } catch {
    return
  }
  if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) return
  const directory = info.isDirectory()
  const wanted = privateMode(info.mode & 0o7777, directory)
  if ((info.mode & 0o7777) !== wanted) {
    try {
      chmodSync(path, wanted)
    } catch {}
  }
  if (!directory || depth >= MAX_DEPTH) return
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch {
    return
  }
  for (const entry of entries) harden(join(path, entry), depth + 1)
}
