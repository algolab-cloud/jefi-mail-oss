import { Database } from 'bun:sqlite'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupBeforeMigrating, pruneBackups } from './db-backup'
import { MIGRATIONS, migrate, openDatabase } from './db'

const cleanups: Array<() => unknown> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jefi-db-backup-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const open = (path: string) => {
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  cleanups.push(() => db.close())
  return db
}
const version = (db: Database) => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
const backups = (dir: string) => readdirSync(dir).filter((name) => name.includes('.bak-')).sort()

const STEPS = ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)', 'ALTER TABLE notes ADD COLUMN pinned INTEGER', 'CREATE TABLE tags (name TEXT)', 'CREATE INDEX notes_pinned ON notes (pinned)']

test('pending migrations first copy the database as it was, owner-only', () => {
  const dir = tempDir()
  const path = join(dir, 'mail.db')
  const db = open(path)
  migrate(db, STEPS.slice(0, 1))
  // Still in the WAL, not checkpointed: the copy must hold it all the same.
  db.run('INSERT INTO notes (body) VALUES (?)', ['before the upgrade'])
  migrate(db, STEPS.slice(0, 2))
  expect(version(db)).toBe(2)
  expect(backups(dir)).toEqual(['mail.db.bak-v1'])
  const copyPath = join(dir, 'mail.db.bak-v1')
  expect(statSync(copyPath).mode & 0o777).toBe(0o600)
  const copy = new Database(copyPath, { readonly: true })
  try {
    expect(version(copy)).toBe(1)
    expect(copy.query('SELECT body FROM notes').all()).toEqual([{ body: 'before the upgrade' }])
    // The column the migration added isn't in the copy: it's the schema from before.
    expect((copy.query('PRAGMA table_info(notes)').all() as Array<{ name: string }>).map((c) => c.name)).toEqual(['id', 'body'])
  } finally {
    copy.close()
  }
})

test('a new database, an up-to-date one and an in-memory one get no copy', () => {
  const dir = tempDir()
  const path = join(dir, 'mail.db')
  const db = open(path)
  migrate(db, STEPS)
  expect(backups(dir)).toEqual([])
  migrate(db, STEPS)
  expect(backups(dir)).toEqual([])
  const memory = new Database(':memory:')
  cleanups.push(() => memory.close())
  migrate(memory, STEPS.slice(0, 1))
  expect(backupBeforeMigrating(memory, 1)).toBeNull()
  expect(backupBeforeMigrating(db, 0)).toBeNull()
})

test('only the newest two copies are kept', () => {
  const dir = tempDir()
  const path = join(dir, 'mail.db')
  const db = open(path)
  migrate(db, STEPS.slice(0, 1))
  for (let n = 2; n <= STEPS.length; n++) migrate(db, STEPS.slice(0, n))
  expect(version(db)).toBe(4)
  expect(backups(dir)).toEqual(['mail.db.bak-v2', 'mail.db.bak-v3'])
  // Newest by time, not by number: an old copy with a higher number goes first.
  writeFileSync(join(dir, 'mail.db.bak-v9'), '')
  utimesSync(join(dir, 'mail.db.bak-v9'), new Date(2000, 0, 1), new Date(2000, 0, 1))
  pruneBackups(path)
  expect(backups(dir)).toEqual(['mail.db.bak-v2', 'mail.db.bak-v3'])
  // Files that only look alike are left alone.
  writeFileSync(join(dir, 'mail.db.bak-vold'), '')
  writeFileSync(join(dir, 'other.db.bak-v1'), '')
  pruneBackups(path, 1)
  expect(backups(dir)).toEqual(['mail.db.bak-v3', 'mail.db.bak-vold', 'other.db.bak-v1'])
})

test('a copy left by an earlier try is replaced', () => {
  const dir = tempDir()
  const path = join(dir, 'mail.db')
  const db = open(path)
  migrate(db, STEPS.slice(0, 1))
  writeFileSync(join(dir, 'mail.db.bak-v1'), 'half a copy', { mode: 0o644 })
  migrate(db, STEPS.slice(0, 2))
  const copy = new Database(join(dir, 'mail.db.bak-v1'), { readonly: true })
  cleanups.push(() => copy.close())
  expect(version(copy)).toBe(1)
  expect(statSync(join(dir, 'mail.db.bak-v1')).mode & 0o777).toBe(0o600)
})

test('a copy that cannot be made is logged and the migration still runs', () => {
  const dir = tempDir()
  const path = join(dir, 'mail.db')
  const db = open(path)
  migrate(db, STEPS.slice(0, 1))
  // Something that isn't a file is in the way.
  mkdirSync(join(dir, 'mail.db.bak-v1'))
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  cleanups.push(() => errors.mockRestore())
  migrate(db, STEPS.slice(0, 2))
  expect(version(db)).toBe(2)
  expect(errors).toHaveBeenCalledTimes(1)
  expect(String(errors.mock.calls[0]![0])).toContain("couldn't back up before migrating from v1")
  expect(statSync(join(dir, 'mail.db.bak-v1')).isDirectory()).toBe(true)
})

test('openDatabase backs up a real mail.db that is behind this build', () => {
  const dir = tempDir()
  const path = join(dir, 'mail.db')
  const old = new Database(path, { create: true, strict: true })
  migrate(old, MIGRATIONS.slice(0, MIGRATIONS.length - 1))
  old.close()
  const db = openDatabase(path)
  cleanups.push(() => db.close())
  expect(version(db)).toBe(MIGRATIONS.length)
  expect(backups(dir)).toEqual([`mail.db.bak-v${MIGRATIONS.length - 1}`])
  // A fresh one isn't copied.
  const freshDir = tempDir()
  const fresh = openDatabase(join(freshDir, 'mail.db'))
  cleanups.push(() => fresh.close())
  expect(existsSync(join(freshDir, 'mail.db'))).toBe(true)
  expect(backups(freshDir)).toEqual([])
})
