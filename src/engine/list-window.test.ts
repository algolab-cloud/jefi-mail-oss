import { afterEach, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { seedAccount, seedMailbox } from './testing/seed'
import { createImapEngine } from './imap-engine'
import { hasOlderThreads, loadThreads } from './threads'
import type { EngineEvent } from './types'

// ---------------------------------------------------------------------------
// The list holds a page of conversations at a time and grows on request. Mailboxes here are built
// straight in SQLite: the point is thousands of conversations, not IMAP.
// ---------------------------------------------------------------------------

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const ACCOUNT = seedAccount('acct-window')

/** `count` inbox conversations, one message each, a minute apart and newest first. */
const seedInbox = (db: MailDatabase, count: number) =>
  seedMailbox(db, ACCOUNT.id, ACCOUNT.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count, subject: 'Message' })

const startEngine = (db: MailDatabase) => {
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => engine.dispose())
  return { engine, events }
}

const lastSnapshot = (events: EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { type: 'threadsChanged' }> => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)

/** Snapshots are coalesced on a one-second timer. */
const waitForSnapshot = async (events: EngineEvent[], from: number) => {
  for (let i = 0; i < 300 && !lastSnapshot(events.slice(from)); i++) await Bun.sleep(20)
  const snapshot = lastSnapshot(events.slice(from))
  if (!snapshot) throw new Error('no list snapshot was published')
  return snapshot
}

test('a mailbox past the first page is listed a page at a time, and never shrinks back', async () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  seedInbox(db, 1200)
  const { engine, events } = startEngine(db)

  // First snapshot: a page, and the list knows older mail is waiting.
  engine.setAccounts([ACCOUNT])
  const first = lastSnapshot(events)!
  expect(first.upserts.length).toBe(500)
  expect(first.hasMore).toBe(true)
  expect(first.upserts[0]!.subject).toBe('Message 1')

  // Asking for more widens the window; the rows already shown stay where they were.
  let mark = events.length
  engine.loadMore(ACCOUNT.id)
  const wider = await waitForSnapshot(events, mark)
  expect(wider.upserts.length).toBe(1000)
  expect(wider.hasMore).toBe(true)
  expect(wider.upserts.slice(0, 500).map((t) => t.subject)).toEqual(first.upserts.map((t) => t.subject))

  // A routine publish (here a local change: the Screener) keeps the wider list: no rows are yanked away.
  mark = events.length
  await engine.setScreener(ACCOUNT.id, false)
  const routine = await waitForSnapshot(events, mark)
  expect(routine.upserts.length).toBe(1000)
  expect(routine.upserts[0]!.subject).toBe('Message 1')

  // Past the end there is nothing older left to ask for.
  mark = events.length
  engine.loadMore(ACCOUNT.id)
  const all = await waitForSnapshot(events, mark)
  expect(all.upserts.length).toBe(1200)
  expect(all.hasMore).toBe(false)
})

test('a mailbox inside one page reports nothing older', () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  seedInbox(db, 3)
  expect(loadThreads(db, ACCOUNT.id).length).toBe(3)
  expect(hasOlderThreads(db, ACCOUNT.id, 500)).toBe(false)
  expect(hasOlderThreads(db, ACCOUNT.id, 2)).toBe(true)
})
