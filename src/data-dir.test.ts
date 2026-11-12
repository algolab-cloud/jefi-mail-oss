import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDatabase } from './engine/db'
import { hardenDataDir, preparePrivateDatabase, privateMode } from './data-dir'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tempDir = () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-data-dir-`)
  dirs.push(dir)
  return dir
}
const modeOf = (path: string) => statSync(path).mode & 0o7777

test('group and others lose every bit; the owner keeps read and write, and an execute bit it had', () => {
  expect(privateMode(0o644, false)).toBe(0o600)
  expect(privateMode(0o666, false)).toBe(0o600)
  expect(privateMode(0o400, false)).toBe(0o600)
  expect(privateMode(0o755, false)).toBe(0o700)
  expect(privateMode(0o755, true)).toBe(0o700)
  expect(privateMode(0o4755, false)).toBe(0o700)
})

test('an install an older build left world-readable is made private, folders and all', () => {
  const root = tempDir()
  const dir = `${root}/jefi`
  mkdirSync(`${dir}/attachments/abc/1-def/0`, { recursive: true, mode: 0o755 })
  mkdirSync(`${dir}/link-protection`, { mode: 0o755 })
  for (const name of ['mail.db', 'mail.db-wal', 'mail.db-shm', 'accounts.json', 'settings.json']) writeFileSync(`${dir}/${name}`, 'x', { mode: 0o644 })
  writeFileSync(`${dir}/secrets.vault`, 'x', { mode: 0o600 })
  writeFileSync(`${dir}/apply-update.sh`, 'x', { mode: 0o700 })
  writeFileSync(`${dir}/attachments/abc/1-def/0/report.pdf`, 'x', { mode: 0o644 })
  writeFileSync(`${dir}/link-protection/snapshot.json`, 'x', { mode: 0o644 })
  for (const path of [dir, `${dir}/attachments`, `${dir}/attachments/abc`, `${dir}/link-protection`]) chmodSync(path, 0o755)
  // A link out of the folder is not followed.
  const outside = `${root}/outside.txt`
  writeFileSync(outside, 'x', { mode: 0o644 })
  symlinkSync(outside, `${dir}/link`)

  hardenDataDir(dir)

  for (const path of [dir, `${dir}/attachments`, `${dir}/attachments/abc`, `${dir}/attachments/abc/1-def`, `${dir}/attachments/abc/1-def/0`, `${dir}/link-protection`]) expect(modeOf(path)).toBe(0o700)
  for (const name of ['mail.db', 'mail.db-wal', 'mail.db-shm', 'accounts.json', 'settings.json', 'secrets.vault', 'attachments/abc/1-def/0/report.pdf', 'link-protection/snapshot.json']) {
    expect(modeOf(`${dir}/${name}`)).toBe(0o600)
  }
  expect(modeOf(`${dir}/apply-update.sh`)).toBe(0o700)
  expect(modeOf(outside)).toBe(0o644)
})

test('a missing data folder is created private, and a missing one never throws', () => {
  const dir = `${tempDir()}/new/jefi`
  hardenDataDir(dir)
  expect(modeOf(dir)).toBe(0o700)
  expect(() => hardenDataDir('/nonexistent-root-for-jefi/jefi')).not.toThrow()
})

test('a new mail database, its -wal and its -shm are owner-only', () => {
  const dir = `${tempDir()}/jefi`
  const db = openDatabase(`${dir}/mail.db`)
  try {
    db.run('CREATE TABLE IF NOT EXISTS probe (x)')
    db.run('INSERT INTO probe VALUES (1)')
    expect(modeOf(dir)).toBe(0o700)
    for (const name of ['mail.db', 'mail.db-wal', 'mail.db-shm']) {
      expect(existsSync(`${dir}/${name}`)).toBe(true)
      expect(modeOf(`${dir}/${name}`)).toBe(0o600)
    }
  } finally {
    db.close()
  }
})

test('an existing world-readable database is made owner-only before it opens', () => {
  const dir = tempDir()
  for (const name of ['mail.db', 'mail.db-wal', 'mail.db-shm']) writeFileSync(`${dir}/${name}`, '', { mode: 0o644 })
  preparePrivateDatabase(`${dir}/mail.db`)
  for (const name of ['mail.db', 'mail.db-wal', 'mail.db-shm']) expect(modeOf(`${dir}/${name}`)).toBe(0o600)
})
