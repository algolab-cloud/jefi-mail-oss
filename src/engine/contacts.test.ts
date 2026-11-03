import { expect, test } from 'bun:test'
import { openDatabase } from './db'
import { loadContacts } from './contacts'
import { ensureAccount, saveMailboxes, storeBatch, type SyncedMessage } from './mail-store'

const ACCOUNT = 'acct-c'
const NOW = Date.UTC(2026, 8, 17, 12)
const DAY = 86_400_000

function setup() {
  const db = openDatabase(':memory:')
  ensureAccount(db, ACCOUNT, 'me@example.com')
  const [inbox] = saveMailboxes(db, ACCOUNT, [{ path: 'INBOX', specialUse: '\\Inbox' }])
  let uid = 1
  const add = (m: Partial<SyncedMessage> & { date: number }) =>
    storeBatch(db, ACCOUNT, { id: inbox!.id, uidvalidity: 1 }, [{ uid: uid++, subject: 's', to: [], cc: [], bcc: [], replyTo: [], references: [], flags: [], ...m }], { lastUid: uid })
  return { db, add }
}

test('ranks people by how often and how recently they appear, skipping your own address', () => {
  const { db, add } = setup()
  add({ from: { name: 'Ada Lovelace', email: 'ada@example.com' }, to: [{ email: 'me@example.com' }], date: NOW - DAY })
  add({ from: { name: 'Ada', email: 'ada@example.com' }, to: [{ email: 'me@example.com' }, { name: 'Kenji Ito', email: 'kenji@example.com' }], date: NOW - 2 * DAY })
  add({ from: { name: 'Old Friend', email: 'old@example.com' }, to: [{ email: 'me@example.com' }], date: NOW - 400 * DAY })
  add({ from: { email: 'me@example.com' }, to: [{ name: 'Nora Hale', email: 'nora@example.com' }], cc: [{ email: 'kenji@example.com' }], date: NOW - 3 * DAY })

  const contacts = loadContacts(db, ACCOUNT, { now: NOW })
  expect(contacts.map((c) => c.email)).toEqual(['ada@example.com', 'kenji@example.com', 'nora@example.com', 'old@example.com'])
  expect(contacts.map((c) => c.name)).toEqual(['Ada Lovelace', 'Kenji Ito', 'Nora Hale', 'Old Friend'])
  expect(contacts[0]!.face).toEqual({ letter: 'AL' })
})

test('falls back to the address when no display name was ever seen', () => {
  const { db, add } = setup()
  add({ from: { email: 'support@acme.test' }, to: [{ email: 'me@example.com' }], date: NOW })
  expect(loadContacts(db, ACCOUNT, { now: NOW })).toEqual([{ name: 'support', email: 'support@acme.test', face: { letter: 'S' } }])
})

test('an empty mailbox has no contacts', () => {
  const { db } = setup()
  expect(loadContacts(db, ACCOUNT, { now: NOW })).toEqual([])
})
