import type { Database } from 'bun:sqlite'
import { chmodSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** How many pre-migration copies of mail.db are kept; older ones are deleted. */
export const KEEP_BACKUPS = 2

/**
 * Before mail.db is migrated from schema `from`, keeps a consistent copy beside it
 * (mail.db.bak-v<from>), so a migration that goes wrong, or a step back to an older Jefi, loses
 * nothing. VACUUM INTO writes a clean, compacted copy that includes what's still in the WAL.
 * Owner-only like the database itself; only the newest KEEP_BACKUPS copies are kept. Nothing is
 * copied for an in-memory database or a new one (schema v0: nothing to lose).
 *
 * A copy that can't be made (a full disk, say) is logged and the migration goes ahead: refusing to
 * open the mailbox would cost more than the copy saves. Returns the copy's path, or null.
 */
export function backupBeforeMigrating(db: Database, from: number, keep = KEEP_BACKUPS): string | null {
  const path = db.filename
  if (from <= 0 || !path || path === ':memory:' || path.startsWith('file:')) return null
  const target = `${path}.bak-v${from}`
  // VACUUM INTO makes its file with the default permissions, so it's made inside a directory only the
  // owner can enter (mkdtemp makes it 0700), made owner-only, and only then moved into place.
  let staging: string | null = null
  try {
    staging = mkdtempSync(join(dirname(path), '.mail-backup-'))
    const copy = join(staging, 'copy.db')
    db.run('VACUUM INTO ?', [copy])
    chmodSync(copy, 0o600)
    rmSync(target, { force: true })
    renameSync(copy, target)
  } catch (error) {
    console.error(`mail.db: couldn't back up before migrating from v${from} (${error instanceof Error ? error.message : String(error)}); migrating anyway`)
    return null
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
  pruneBackups(path, keep)
  return target
}

/** Deletes all but the newest `keep` mail.db.bak-v<N> copies beside `path`. */
export function pruneBackups(path: string, keep = KEEP_BACKUPS): void {
  const dir = dirname(path)
  const prefix = `${basename(path)}.bak-v`
  try {
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .map((name) => ({ name, version: Number(name.slice(prefix.length)), mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || b.version - a.version)
    for (const old of backups.slice(keep)) rmSync(join(dir, old.name), { force: true })
  } catch (error) {
    console.error(`mail.db: couldn't tidy old backups (${error instanceof Error ? error.message : String(error)})`)
  }
}
