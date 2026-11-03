import { afterEach, expect, test } from 'bun:test'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { dueOutgoing, enqueueOutgoing } from './outbox'
import { ensureAccount } from './mail-store'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'
import type { MailThread } from '../data'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

test('a snoozed conversation leaves the Inbox and comes back unread when due', async () => {
  const server = await startImapServer({
    INBOX: [{ raw: rawMessage({ n: 1, subject: 'Read me later' }), flags: ['\\Seen'] }],
    Archive: { 'special-use': '\\Archive', messages: [] },
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false, schedulerMs: 50 })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)
  const waitForThread = async (matches: (thread: MailThread) => boolean) => {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const event = events.filter((x) => x.type === 'threadsChanged' && x.replaceAll).at(-1)
      const thread = event?.type === 'threadsChanged' ? event.upserts[0] : undefined
      if (thread && matches(thread)) return thread
      await Bun.sleep(20)
    }
    throw new Error('Expected snooze state was not published')
  }
  const thread = await waitForThread((thread) => thread.folder === 'inbox')

  engine.snooze(server.account.id, thread.id, Date.now() + 2000)
  const snoozed = await waitForThread((thread) => thread.folder === 'snoozed')
  expect(snoozed.folder).toBe('snoozed')
  expect(snoozed.snoozeUntil).toContain('today')

  const back = await waitForThread((thread) => thread.folder === 'inbox' && thread.unread)
  expect(back.folder).toBe('inbox')
  expect(back.unread).toBe(true)
}, 10_000)

test('a scheduled message is not due until its time', () => {
  const db = openDatabase(':memory:')
  ensureAccount(db, 'a', 'me@example.com')
  const mail = { to: ['x@example.com'], cc: [], bcc: [], subject: 'Later', body: 'Hi' }
  enqueueOutgoing(db, { id: 'later', accountId: 'a', kind: 'message', threadId: 'later', mail, messageId: '<m@x>', sendAt: Date.now() + 60_000 })
  enqueueOutgoing(db, { id: 'now', accountId: 'a', kind: 'message', threadId: 'now', mail, messageId: '<n@x>' })
  expect(dueOutgoing(db, 'a').map((e) => e.id)).toEqual(['now'])
  expect(dueOutgoing(db, 'a', Date.now() + 61_000).map((e) => e.id).sort()).toEqual(['later', 'now'])
})

test('moving a snoozed conversation ends its snooze (Unsnooze, archive, delete)', async () => {
  const server = await startImapServer({
    INBOX: [{ raw: rawMessage({ n: 1, subject: 'Read me later' }), flags: ['\\Seen'] }],
    Archive: { 'special-use': '\\Archive', messages: [] },
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  const latest = () => {
    const event = events.filter((x) => x.type === 'threadsChanged' && x.replaceAll).at(-1)
    return event?.type === 'threadsChanged' ? event.upserts[0] : undefined
  }
  const waitForThread = async (matches: (thread: MailThread) => boolean) => {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const thread = latest()
      if (thread && matches(thread)) return thread
      await Bun.sleep(20)
    }
    throw new Error(`Expected state was not published; last was ${latest()?.folder}`)
  }
  const thread = await waitForThread((thread) => thread.folder === 'inbox')
  engine.snooze(server.account.id, thread.id, Date.now() + 60_000)
  await waitForThread((thread) => thread.folder === 'snoozed')

  // "Unsnooze" in the reader is a move to the Inbox.
  engine.move(server.account.id, thread.id, 'inbox')
  const back = await waitForThread((thread) => thread.folder === 'inbox')
  expect(back.snoozeUntil).toBeUndefined()
  expect(db.query('SELECT count(*) AS n FROM snoozes').get()).toEqual({ n: 0 })
}, 10_000)
