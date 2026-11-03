import { afterEach, expect, test } from 'bun:test'
import type { Account } from '../accounts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDatabase, openDatabaseReadOnly, type MailDatabase } from './db'
import { seedAccount, seedMailbox } from './testing/seed'
import { createImapEngine } from './imap-engine'
import { countInboxUnread, unreadAcrossAccounts } from './threads'
import { snoozeThread } from './snooze'

// ---------------------------------------------------------------------------
// The Assistant's catch-up across accounts: the newest unread Inbox conversations of every
// account, bounded, tagged with their account, and never Junk, Trash, snoozed or screened mail.
// ---------------------------------------------------------------------------

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const HOME: Account = { ...seedAccount('acct-home'), email: 'me@home.example', label: 'Personal' }
const WORK: Account = { ...seedAccount('acct-work'), email: 'me@work.example' }

const unread = (db: MailDatabase, ids: number[]) => db.run(`UPDATE messages SET seen = 0 WHERE id IN (${ids.join(',')})`)

function seed() {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  const put = (account: Account, path: string, specialUse: string, count: number, subject: string, minutesAgo: number) =>
    seedMailbox(db, account.id, account.email, { path, specialUse }, { count, subject, minutesAgo })
  // Home: 3 unread and 2 read in the Inbox, unread mail in Junk and Trash.
  const home = put(HOME, 'INBOX', '\\Inbox', 5, 'Home', 1)
  unread(db, home.slice(0, 3))
  unread(db, put(HOME, 'Junk', '\\Junk', 2, 'Spam', 0))
  unread(db, put(HOME, 'Trash', '\\Trash', 2, 'Binned', 0))
  // Work: 4 unread, interleaved in time with Home's.
  const work = put(WORK, 'INBOX', '\\Inbox', 4, 'Work', 1.5)
  unread(db, work)
  return { db, home, work }
}

test('the newest unread Inbox mail of every account, tagged with its account', () => {
  const { db } = seed()
  const found = unreadAcrossAccounts(db, [HOME, WORK], 50)
  expect(found.map((f) => f.thread.subject)).toEqual(['Home 1', 'Work 1', 'Home 2', 'Work 2', 'Home 3', 'Work 3', 'Work 4'])
  expect(found.every((f) => f.thread.unread && f.thread.folder === 'inbox')).toBe(true)
  expect(found.find((f) => f.thread.subject === 'Home 1')!.account).toEqual({ id: HOME.id, email: HOME.email, label: 'Personal' })
  expect(found.find((f) => f.thread.subject === 'Work 1')!.account).toEqual({ id: WORK.id, email: WORK.email })
  // Ids carry their account, so the store can route actions on them.
  expect(found.every((f) => f.thread.id.startsWith(`${f.account.id}:`))).toBe(true)
})

test('bounded by the limit across accounts, not per account', () => {
  const { db } = seed()
  expect(unreadAcrossAccounts(db, [HOME, WORK], 3).map((f) => f.thread.subject)).toEqual(['Home 1', 'Work 1', 'Home 2'])
  expect(unreadAcrossAccounts(db, [HOME, WORK], 0)).toEqual([])
  expect(unreadAcrossAccounts(db, [], 10)).toEqual([])
})

test('snoozed and screened conversations are left out', () => {
  const { db, work } = seed()
  const home1 = unreadAcrossAccounts(db, [HOME], 1)[0]!.thread.id
  snoozeThread(db, HOME.id, home1, Date.now() + 86_400_000)
  // A new sender waiting in Work's Screener.
  db.run("UPDATE messages SET from_email = 'stranger@example.com' WHERE id = ?", [work[0]!])
  db.run('INSERT INTO screener (account_id, enabled_at) VALUES (?, ?)', [WORK.id, 0])
  db.run("INSERT INTO sender_verdicts (account_id, email, verdict) VALUES (?, 'ada@example.com', 'allow')", [WORK.id])
  const subjects = unreadAcrossAccounts(db, [HOME, WORK], 50).map((f) => f.thread.subject)
  expect(subjects).toEqual(['Home 2', 'Work 2', 'Home 3', 'Work 3', 'Work 4'])
})

test('the engine serves it for the accounts it was given', async () => {
  const { db } = seed()
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  cleanups.push(() => engine.dispose())
  engine.setAccounts([HOME, WORK])
  const found = await engine.unreadAcrossAccounts(2)
  expect(found.map((f) => [f.account.email, f.thread.subject])).toEqual([
    [HOME.email, 'Home 1'],
    [WORK.email, 'Work 1'],
  ])
  // Summaries only: no bodies go out with the list.
  expect(found.every((f) => f.thread.messages.every((m) => !m.html))).toBe(true)
  engine.setAccounts([WORK])
  expect((await engine.unreadAcrossAccounts(50)).every((f) => f.account.id === WORK.id)).toBe(true)
})

// The count the CLI's `unread` (and the menu-bar extensions) report: the length of the full list,
// without building it.
const listed = (db: MailDatabase, account: Account) => unreadAcrossAccounts(db, [account], 1_000_000).length

test('the unread count matches the list, through snoozes, the Screener, threads and own drafts', () => {
  const { db, home, work } = seed()
  expect([countInboxUnread(db, HOME), countInboxUnread(db, WORK)]).toEqual([3, 4])
  const check = () => {
    for (const account of [HOME, WORK]) expect(countInboxUnread(db, account)).toBe(listed(db, account))
  }
  snoozeThread(db, HOME.id, unreadAcrossAccounts(db, [HOME], 1)[0]!.thread.id, Date.now() + 86_400_000)
  check()
  // Threaded: one unread reply makes the whole conversation unread; a read one stays out.
  db.run("UPDATE messages SET thread_id = 't1' WHERE id IN (?, ?)", [home[3]!, home[1]!])
  db.run("UPDATE messages SET thread_id = 't2' WHERE id = ?", [home[4]!])
  check()
  // The Screener goes by the newest message from someone else; my own later reply doesn't hide it.
  db.run("UPDATE messages SET from_email = 'stranger@example.com' WHERE id = ?", [work[0]!])
  db.run("UPDATE messages SET thread_id = 'w1' WHERE id IN (?, ?)", [work[1]!, work[2]!])
  db.run("UPDATE messages SET from_email = 'Me@Work.example' WHERE id = ?", [work[1]!])
  db.run("UPDATE messages SET from_email = 'Stranger@example.com' WHERE id = ?", [work[2]!])
  db.run('INSERT INTO screener (account_id, enabled_at) VALUES (?, ?)', [WORK.id, 0])
  db.run("INSERT INTO sender_verdicts (account_id, email, verdict) VALUES (?, 'ada@example.com', 'allow')", [WORK.id])
  check()
  expect(countInboxUnread(db, WORK)).toBe(1)
  // A sender allowed out of the Screener counts again.
  db.run("INSERT INTO sender_verdicts (account_id, email, verdict) VALUES (?, 'stranger@example.com', 'allow')", [WORK.id])
  check()
  // The server copy of one of Jefi's own drafts is not shown, so it doesn't count either.
  const copy = db.query('SELECT message_id FROM messages WHERE id = ?').get(work[3]!) as { message_id: string }
  db.run("INSERT INTO drafts (id, account_id, remote_message_id, mail_json, updated_at) VALUES ('d1', ?, ?, '{}', 0)", [WORK.id, copy.message_id])
  check()
  // Nothing unread: nothing counted.
  db.run('UPDATE messages SET seen = 1')
  check()
  expect(countInboxUnread(db, WORK)).toBe(0)
})

test('counting 30k unread conversations stays well under the menu bar poll budget', () => {
  // Read-only, as the CLI opens it: threading 30k new messages is the app's job, not the count's.
  const dir = mkdtempSync(`${tmpdir()}/jefi-count-`)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const seeded = openDatabase(`${dir}/mail.db`)
  unread(seeded, seedMailbox(seeded, WORK.id, WORK.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 30_000, subject: 'Bulk' }))
  seedMailbox(seeded, WORK.id, WORK.email, { path: 'Archive', specialUse: '\\Archive' }, { count: 5_000, subject: 'Old' })
  seeded.run("INSERT INTO sender_verdicts (account_id, email, verdict) VALUES (?, 'ada@example.com', 'allow')", [WORK.id])
  seeded.run('INSERT INTO screener (account_id, enabled_at) VALUES (?, ?)', [WORK.id, 0])
  seeded.close()
  const db = openDatabaseReadOnly(`${dir}/mail.db`)
  cleanups.push(() => db.close())
  const started = performance.now()
  expect(countInboxUnread(db, WORK)).toBe(30_000)
  expect(performance.now() - started).toBeLessThan(300)
}, 60_000)
