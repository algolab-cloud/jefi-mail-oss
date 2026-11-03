import { describe, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { ensureAccount, saveMailboxes, storeBatch, type SyncedMessage } from './mail-store'
import { queueFlags, queueMove } from './pending-ops'
import { THREAD_OF_MESSAGE_ID, THREAD_OF_REPLIES, assignThreads, normalizeSubject, threadMessageIds } from './threading'
import { loadThreads } from './threads'

const ACCOUNT = 'acct-t'
const DAY = 86_400_000
const BASE = Date.UTC(2026, 8, 1, 9)

function setup() {
  const db = openDatabase(':memory:')
  ensureAccount(db, ACCOUNT, 'me@example.com')
  const boxes = saveMailboxes(db, ACCOUNT, [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Sent', specialUse: '\\Sent' },
    { path: 'Archive', specialUse: '\\Archive' },
  ])
  const byPath = Object.fromEntries(boxes.map((b) => [b.path, b.id])) as Record<string, number>
  let uid = 1
  const add = (path: string, m: Partial<SyncedMessage> & { subject: string; date: number }) =>
    storeBatch(db, ACCOUNT, { id: byPath[path]!, uidvalidity: 1 }, [
      { uid: uid++, to: [], cc: [], bcc: [], replyTo: [], references: [], flags: ['\\Seen'], from: { name: path === 'Sent' ? 'Me' : 'Ada', email: path === 'Sent' ? 'me@example.com' : 'ada@example.com' }, ...m },
    ], { lastUid: uid })
  return { db, add }
}

const conversations = (db: MailDatabase) =>
  loadThreads(db, ACCOUNT, { now: new Date(BASE + 90 * DAY) }).map((t) => ({ subject: t.subject, folder: t.folder, count: t.messages.length }))

describe('threading', () => {
  test('a reply chain across Inbox and Sent is one conversation, in Inbox, oldest message first', () => {
    const { db, add } = setup()
    add('INBOX', { subject: 'Offsite', messageId: '<a@x>', date: BASE })
    add('Sent', { subject: 'Re: Offsite', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], date: BASE + 3600_000 })
    add('INBOX', { subject: 'Re: Offsite', messageId: '<c@x>', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'], date: BASE + 7200_000, flags: [] })
    add('INBOX', { subject: 'Unrelated', messageId: '<z@x>', date: BASE + 60_000 })

    const threads = loadThreads(db, ACCOUNT, { now: new Date(BASE + DAY) })
    expect(threads.map((t) => [t.subject, t.folder, t.messages.length, t.unread])).toEqual([
      ['Offsite', 'inbox', 3, true],
      ['Unrelated', 'inbox', 1, false],
    ])
    expect(threads[0]!.messages.map((m) => m.from)).toEqual(['Ada', 'Me', 'Ada'])
    expect(threads[0]!.sender).toBe('Ada, Me (3)')
  })

  test('a reply that syncs before its parent still joins it', () => {
    const { db, add } = setup()
    add('INBOX', { subject: 'Re: Budget', messageId: '<child@x>', inReplyTo: '<parent@x>', references: ['<parent@x>'], date: BASE + 1000 })
    expect(assignThreads(db, ACCOUNT)).toBe(1)
    add('Archive', { subject: 'Budget', messageId: '<parent@x>', date: BASE })
    expect(conversations(db)).toEqual([{ subject: 'Budget', folder: 'inbox', count: 2 }])
  })

  test('a message referencing two separate threads merges them', () => {
    const { db, add } = setup()
    add('INBOX', { subject: 'Plan A', messageId: '<p1@x>', date: BASE })
    add('INBOX', { subject: 'Plan B', messageId: '<p2@x>', date: BASE + 1000 })
    assignThreads(db, ACCOUNT)
    expect(conversations(db).length).toBe(2)
    add('INBOX', { subject: 'Re: Plans', messageId: '<m@x>', inReplyTo: '<p2@x>', references: ['<p1@x>', '<p2@x>'], date: BASE + 2000 })
    expect(conversations(db)).toEqual([{ subject: 'Plan A', folder: 'inbox', count: 3 }])
  })

  test('References alone are enough', () => {
    const { db, add } = setup()
    add('INBOX', { subject: 'Design review', messageId: '<r1@x>', date: BASE })
    add('INBOX', { subject: 'Notes from the review', messageId: '<r2@x>', references: ['<r1@x>'], date: BASE + 1000 })
    expect(conversations(db)).toEqual([{ subject: 'Design review', folder: 'inbox', count: 2 }])
  })

  test('replies from clients that drop headers fall back to the subject, within 30 days', () => {
    const { db, add } = setup()
    add('INBOX', { subject: 'Invoice 4471', messageId: '<i1@x>', date: BASE })
    add('INBOX', { subject: 'RE: invoice 4471', messageId: '<i2@x>', date: BASE + 2 * DAY })
    add('INBOX', { subject: 'Re: Invoice 4471', messageId: '<i3@x>', date: BASE + 45 * DAY })
    add('INBOX', { subject: 'Invoice 4471', messageId: '<i4@x>', date: BASE + 3 * DAY }) // not a reply: new thread
    expect(conversations(db).map((c) => c.count).sort()).toEqual([1, 1, 2])
  })

  test('normalizeSubject strips reply and forward prefixes in several languages', () => {
    expect(normalizeSubject('Re: Fwd: RE[2]: AW: Hello  there')).toBe('hello there')
    expect(normalizeSubject('SV: Möte')).toBe('möte')
  })
})

describe('actions on a conversation', () => {
  test('starring and reading apply to every message; archiving leaves your Sent copies', () => {
    const { db, add } = setup()
    add('INBOX', { subject: 'Offsite', messageId: '<a@x>', date: BASE, flags: [] })
    add('Sent', { subject: 'Re: Offsite', messageId: '<b@x>', inReplyTo: '<a@x>', date: BASE + 1000 })
    add('INBOX', { subject: 'Re: Offsite', messageId: '<c@x>', inReplyTo: '<b@x>', date: BASE + 2000, flags: [] })
    const [thread] = loadThreads(db, ACCOUNT, { now: new Date(BASE + DAY) })
    expect(threadMessageIds(db, ACCOUNT, thread!.id).length).toBe(3)

    queueFlags(db, ACCOUNT, thread!.id, { starred: true, unread: false })
    expect(db.query('SELECT count(*) n FROM messages WHERE flagged = 1 AND seen = 1').get()).toEqual({ n: 3 })

    queueMove(db, ACCOUNT, thread!.id, 'archive')
    const placement = db
      .query('SELECT m.subject, mb.path FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id JOIN mailboxes mb ON mb.id = mm.mailbox_id ORDER BY m.date')
      .all()
    expect(placement).toEqual([
      { subject: 'Offsite', path: 'Archive' },
      { subject: 'Re: Offsite', path: 'Sent' },
      { subject: 'Re: Offsite', path: 'Archive' },
    ])
    expect(loadThreads(db, ACCOUNT, { now: new Date(BASE + DAY) }).map((t) => t.folder)).toEqual(['archive'])
  })
})

test('thread lookups search their own index, not every threaded message of the account', () => {
  const db = openDatabase(':memory:')
  const plan = (sql: string) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all('a', 'x') as Array<{ detail: string }>).map((r) => r.detail).join('; ')
  expect(plan(THREAD_OF_MESSAGE_ID)).toContain('messages_message_id (account_id=? AND message_id=?)')
  expect(plan(THREAD_OF_REPLIES)).toContain('messages_in_reply_to (account_id=? AND in_reply_to=?)')
})
