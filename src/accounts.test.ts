import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { accountsToKeep, loadAccounts, saveAccounts } from './accounts'

// Startup purge deletes mail for accounts accounts.json doesn't list, so it must only ever run
// against a list that loaded cleanly. Never the real ~/.config/jefi: each test gets its own dir.
let dir = ''
const previous = process.env.JEFI_CONFIG_DIR
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jefi-accounts-'))
  process.env.JEFI_CONFIG_DIR = dir
})
afterEach(() => {
  if (previous === undefined) delete process.env.JEFI_CONFIG_DIR
  else process.env.JEFI_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

const write = (content: string) => writeFileSync(join(dir, 'accounts.json'), content)
const account = (id: string) => ({ id, name: 'Me', email: `${id}@example.com`, provider: 'imap', face: { letter: 'M' }, servers: {} })

test('a cleanly loaded list is what the purge keeps', () => {
  write(JSON.stringify({ accounts: [account('acct-a'), account('acct-b')], activeId: 'acct-a' }))
  const loaded = loadAccounts()
  expect(loaded.loaded).toBe(true)
  expect(accountsToKeep(loaded)).toEqual(['acct-a', 'acct-b'])
})

test('no purge without accounts.json: a fresh install, or a file that went missing', () => {
  const loaded = loadAccounts()
  expect(loaded).toMatchObject({ accounts: [], loaded: false })
  expect(accountsToKeep(loaded)).toBeNull()
})

test('no purge when accounts.json is unreadable or not the shape we wrote', () => {
  for (const content of ['{"accounts": [', '', 'null', '{"accounts": {}}', '{"activeId": "acct-a"}', `{"accounts": [${JSON.stringify(account('acct-a'))}, null]}`]) {
    write(content)
    expect(accountsToKeep(loadAccounts())).toBeNull()
  }
})

test('no purge for an empty list, which is also what gets saved after a failed load', () => {
  write(JSON.stringify({ accounts: [], activeId: '' }))
  const loaded = loadAccounts()
  expect(loaded.loaded).toBe(true)
  expect(accountsToKeep(loaded)).toBeNull()
})

test('no purge when any listed account has no id', () => {
  const { id: _, ...noId } = account('acct-b')
  write(JSON.stringify({ accounts: [account('acct-a'), noId], activeId: 'acct-a' }))
  expect(accountsToKeep(loadAccounts())).toBeNull()
  write(JSON.stringify({ accounts: [account('acct-a'), { ...account('x'), id: '' }], activeId: 'acct-a' }))
  expect(accountsToKeep(loadAccounts())).toBeNull()
})

test('an unreadable accounts.json is moved aside, never deleted', () => {
  write('{"accounts": [')
  const loaded = loadAccounts()
  expect(loaded).toMatchObject({ accounts: [], loaded: false })
  expect(loaded.backup).toMatch(/accounts\.json\.corrupt-/)
  expect(existsSync(join(dir, 'accounts.json'))).toBe(false)
  expect(readFileSync(loaded.backup!, 'utf8')).toBe('{"accounts": [')
  expect(accountsToKeep(loaded)).toBeNull()
})

test('a missing accounts.json is a fresh install, not a corrupt one', () => {
  expect(loadAccounts().backup).toBeUndefined()
  expect(readdirSync(dir)).toEqual([])
})

test('saves are atomic and leave the backup alone', () => {
  write('not json')
  const { backup } = loadAccounts()
  const data = { accounts: [account('acct-a')] as never, activeId: 'acct-a' }
  saveAccounts(data)
  saveAccounts({ ...data, activeId: '' })
  expect(readdirSync(dir).sort()).toEqual(['accounts.json', backup!.slice(dir.length + 1)])
  expect(JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))).toEqual({ ...data, activeId: '' })
  expect(readFileSync(backup!, 'utf8')).toBe('not json')
  expect(loadAccounts()).toMatchObject({ loaded: true })
  expect(loadAccounts().backup).toBeUndefined()
})

test('a hand-edited entry without servers is repaired from its address, and still kept', () => {
  const { servers: _, ...bare } = account('acct-a')
  write(JSON.stringify({ accounts: [{ ...bare, email: 'me@gmail.com' }, { id: 'acct-b', name: 'B', provider: 'imap', face: { letter: 'B' } }], activeId: 'acct-a' }))
  const loaded = loadAccounts()
  expect(loaded.accounts[0]!.servers.imapHost).toBe('imap.gmail.com')
  expect(loaded.accounts[1]!.email).toBe('')
  expect(loaded.accounts[1]!.servers).toMatchObject({ imapHost: '', smtpHost: '' })
  expect(accountsToKeep(loaded)).toEqual(['acct-a', 'acct-b'])
})
