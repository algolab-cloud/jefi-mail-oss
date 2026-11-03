import { afterEach, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { seedAccount, seedMailbox } from './testing/seed'
import { createImapEngine } from './imap-engine'
import { loadThreads, loadView } from './threads'
import { gmailLabelId } from './pending-ops'
import { threadInView, type MailboxView } from '../view'
import type { EngineEvent, MailEngine } from './types'

// ---------------------------------------------------------------------------
// A view is paged by itself, not by the account's newest. The mailbox here is deliberately lopsided:
// 700 recent Inbox conversations, and every other view holding only mail older than all of them —
// the shape that used to make an old folder look empty.
// ---------------------------------------------------------------------------

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const ACCOUNT = seedAccount('acct-view')
const WORK = gmailLabelId(ACCOUNT.id, 'Work')
/** Past the 500 of the account window, so nothing below shows up without a view query. */
const OLD = 700

function seed(db: MailDatabase) {
  const put = (mailbox: Parameters<typeof seedMailbox>[3], messages: Parameters<typeof seedMailbox>[4]) => seedMailbox(db, ACCOUNT.id, ACCOUNT.email, mailbox, messages)
  put({ path: 'INBOX', specialUse: '\\Inbox' }, { count: OLD, subject: 'Inbox' })
  put({ path: 'Receipts' }, { count: 40, subject: 'Receipt', minutesAgo: 10_000 })
  put({ path: 'Sent', specialUse: '\\Sent' }, { count: 30, subject: 'Sent note', minutesAgo: 20_000 })
  put({ path: 'Archive', specialUse: '\\Archive' }, { count: 25, subject: 'Filed', minutesAgo: 30_000 })
  put({ path: 'Work', specialUse: '\\All' }, { count: 20, subject: 'Work item', minutesAgo: 40_000, labels: ['Work'] })
  put({ path: 'Old starred', specialUse: '\\Archive' }, { count: 15, subject: 'Kept', minutesAgo: 50_000, flagged: true })
}

const start = (db: MailDatabase) => {
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => engine.dispose())
  engine.setAccounts([ACCOUNT])
  return { engine: engine as MailEngine, events }
}

const subjects = (threads: Array<{ subject: string }>) => threads.map((t) => t.subject)

test('every view is paged by its own mail, however old it is', async () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  seed(db)
  const { engine, events } = start(db)

  // The account window is the newest 500, so it is Inbox and nothing else.
  const snapshot = events.filter((e) => e.type === 'threadsChanged' && e.replaceAll).at(-1)!
  const listed = snapshot.type === 'threadsChanged' ? snapshot.upserts : []
  expect(listed.length).toBe(500)
  expect(listed.every((t) => t.subject.startsWith('Inbox'))).toBe(true)
  expect(listed.some((t) => t.subject.startsWith('Receipt'))).toBe(false)

  // Each view still finds its own, newest first, though all of it is older than the window.
  // Archive holds \Archive and \All alike, so the labelled and starred folders' mail counts there too.
  const cases: Array<[MailboxView, string, number]> = [
    ['folder:Receipts', 'Receipt', 40],
    ['sent', 'Sent note', 30],
    ['archive', 'Filed', 25 + 20 + 15],
    [`label:${WORK}`, 'Work item', 20],
    ['starred', 'Kept', 15],
  ]
  for (const [view, subject, count] of cases) {
    const page = (await engine.loadView(ACCOUNT.id, view, { limit: 10 }))!
    expect(page.threads.length).toBe(10)
    expect(page.hasMore).toBe(true)
    expect(subjects(page.threads)).toEqual(Array.from({ length: 10 }, (_, i) => `${subject} ${i + 1}`))

    // Everything, and then there is no more.
    const all = (await engine.loadView(ACCOUNT.id, view, { limit: count }))!
    expect(all.threads.length).toBe(count)
    expect(all.hasMore).toBe(false)
  }
})

test('a later publish leaves a view query alone', async () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  seed(db)
  const { engine, events } = start(db)

  const before = (await engine.loadView(ACCOUNT.id, 'folder:Receipts', { limit: 40 }))!
  expect(before.threads.length).toBe(40)

  // A local change republishes the account list; the folder is queried on its own, so it is untouched.
  const mark = events.length
  await engine.setScreener(ACCOUNT.id, false)
  for (let i = 0; i < 200 && !events.slice(mark).some((e) => e.type === 'threadsChanged'); i++) await Bun.sleep(20)
  const after = (await engine.loadView(ACCOUNT.id, 'folder:Receipts', { limit: 40 }))!
  expect(subjects(after.threads)).toEqual(subjects(before.threads))
  expect(after.hasMore).toBe(false)
})

test('the view query and the rule the list filters by agree', async () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  seed(db)

  // Everything the account holds, decided by the shared rule, against what SQL narrowed to.
  const everything = loadThreads(db, ACCOUNT.id, { limit: 10_000, account: { name: ACCOUNT.name, email: ACCOUNT.email } })
  const views: MailboxView[] = ['inbox', 'sent', 'archive', 'drafts', 'trash', 'spam', 'starred', `label:${WORK}`, 'folder:Receipts', 'folder:Work']
  for (const view of views) {
    const page = loadView(db, ACCOUNT.id, view, { limit: 10_000, account: { name: ACCOUNT.name, email: ACCOUNT.email } })!
    const expected = everything.filter((thread) => threadInView(thread, view))
    expect({ view, ids: page.threads.map((t) => t.id).sort() }).toEqual({ view, ids: expected.map((t) => t.id).sort() })
  }
})

test('views the engine cannot narrow say so, and fall back to the account window', () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  seed(db)
  // Snoozed and the Outbox are local state.
  expect(loadView(db, ACCOUNT.id, 'snoozed')).toBeNull()
  expect(loadView(db, ACCOUNT.id, 'outbox')).toBeNull()
  expect(loadView(db, ACCOUNT.id, 'screener')).toBeNull()
  // A label Jefi keeps itself is in mail.db (local-labels.ts), so SQL narrows it like a Gmail label.
  expect(loadView(db, ACCOUNT.id, 'label:lb:acct-view:none')).toEqual(expect.objectContaining({ threads: [], hasMore: false }))
})
