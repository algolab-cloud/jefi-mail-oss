import { afterEach, expect, test } from 'bun:test'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { parseUnsubscribe } from './scrub'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const UNSUB = ['List-Unsubscribe: <mailto:leave@deals.example?subject=unsubscribe>, <https://deals.example/u/42>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click']

const servers = new Map<string, Awaited<ReturnType<typeof startImapServer>>>()
const serverFor = (account: { id: string }) => servers.get(account.id)!

async function setup() {
  const deals = (n: number, day: number) =>
    ({ raw: rawMessage({ n, fromName: 'Deals', fromEmail: 'news@deals.example', subject: `Sale ${n}`, date: new Date(Date.UTC(2026, 0, day)), extraHeaders: UNSUB }) })
  const server = await startImapServer({
    INBOX: [deals(1, 1), deals(2, 2), deals(3, 3), { raw: rawMessage({ n: 4, fromEmail: 'friend@example.com', subject: 'Hi' }) }],
    Trash: { 'special-use': '\\Trash', messages: [] },
    Archive: { 'special-use': '\\Archive', messages: [] },
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)
  servers.set(server.account.id, server)
  return { engine, db, account: server.account }
}

test('the sender report groups repeat senders and knows who offers unsubscribe', async () => {
  const { engine, account } = await setup()
  const senders = await engine.scrubReport(account.id, 'senders')
  expect(senders.map((g) => [g.detail, g.messages, g.canUnsubscribe])).toEqual([['news@deals.example', 3, true]])
  expect((await engine.scrubReport(account.id, 'newsletters')).map((g) => g.detail)).toEqual(['news@deals.example'])
})

test('scrub moves a sender to Trash keeping the newest, and undo puts them back', async () => {
  const { engine, db, account } = await setup()
  const moves = await engine.scrub(account.id, { sender: 'news@deals.example' }, 'trash', 1)
  expect(moves).toHaveLength(2)
  const inTrash = () =>
    (db.query(`SELECT count(*) AS n FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mb.special_use = '\\Trash'`).get() as { n: number }).n
  expect(inTrash()).toBe(2)
  // The newest one stays where it was.
  expect((await engine.scrubReport(account.id, 'senders'))[0]?.messages ?? 1).toBe(1)
  engine.unscrub(account.id, moves)
  expect(inTrash()).toBe(0)
})

test('purging a sender erases their mail on the server, not just here', async () => {
  const { engine, db, account } = await setup()
  const deals = () => (db.query("SELECT count(*) AS n FROM messages WHERE lower(from_email) = 'news@deals.example'").get() as { n: number }).n
  expect(deals()).toBe(3)
  // Nothing to undo: it is gone, so no moves come back.
  expect(await engine.scrub(account.id, { sender: 'news@deals.example' }, 'purge', 1)).toEqual([])
  // Locally the rows are gone at once; the newest is kept.
  expect(deals()).toBe(1)
  // And it reaches the server: the replay deletes those UIDs from INBOX.
  for (let i = 0; i < 300; i++) {
    const pending = (db.query("SELECT count(*) AS n FROM pending_ops WHERE kind = 'delete'").get() as { n: number }).n
    if (pending === 0) break
    await Bun.sleep(20)
  }
  const client = await serverFor(account).connect()
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      const subjects: string[] = []
      for await (const message of client.fetch('1:*', { envelope: true })) subjects.push(message.envelope?.subject ?? '')
      // Sale 3 is the newest and was kept; the other two are gone from the server.
      expect(subjects.filter((s) => s.startsWith('Sale'))).toEqual(['Sale 3'])
      expect(subjects).toContain('Hi')
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
})

test('unsubscribe headers parse into one-click, link and mailto', () => {
  expect(parseUnsubscribe('<mailto:leave@deals.example?subject=unsubscribe>, <https://deals.example/u/42>', true)).toEqual({
    oneClick: 'https://deals.example/u/42',
    link: 'https://deals.example/u/42',
    mailto: 'mailto:leave@deals.example?subject=unsubscribe',
  })
  expect(parseUnsubscribe('<https://x.example/u>', false).oneClick).toBeNull()
})

test('sender profiles cover Inbox senders, with who the person writes to and their recent subjects', async () => {
  const deals = (n: number, day: number) =>
    ({ raw: rawMessage({ n, fromName: 'Deals', fromEmail: 'news@deals.example', subject: `Sale ${n}`, date: new Date(Date.UTC(2026, 0, day)), extraHeaders: UNSUB }) })
  const sent = rawMessage({ n: 9, fromName: 'Me', fromEmail: USER.user, subject: 'Re: Hi' }).replace('To: Me <me@example.com>', 'To: Friend <friend@example.com>')
  const server = await startImapServer({
    INBOX: [deals(1, 1), deals(2, 2), deals(3, 3), { raw: rawMessage({ n: 4, fromName: 'Friend', fromEmail: 'friend@example.com', subject: 'Hi' }) }],
    Archive: { 'special-use': '\\Archive', messages: [{ raw: rawMessage({ n: 5, fromEmail: 'old@archive.example', subject: 'Long ago' }) }] },
    Sent: { 'special-use': '\\Sent', messages: [{ raw: sent }] },
    Trash: { 'special-use': '\\Trash', messages: [] },
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)

  const profiles = await engine.senderProfiles(server.account.id)
  // Only senders with mail in the Inbox, busiest first; the archived-only sender and the person themselves are left out.
  expect(profiles.map((p) => p.detail)).toEqual(['news@deals.example', 'friend@example.com'])
  const [news, friend] = profiles
  expect(news).toMatchObject({ messages: 3, canUnsubscribe: true, bulk: true, wrote: 0, subjects: ['Sale 3', 'Sale 2', 'Sale 1'] })
  expect(friend).toMatchObject({ messages: 1, canUnsubscribe: false, bulk: false, wrote: 1, subjects: ['Hi'] })
})

test('sender and Spam conversations are listed newest first, and a scrub leaves the kept ones alone', async () => {
  const deals = (n: number, day: number) =>
    ({ raw: rawMessage({ n, fromName: 'Deals', fromEmail: 'news@deals.example', subject: `Sale ${n}`, date: new Date(Date.UTC(2026, 0, day)), extraHeaders: UNSUB }) })
  const server = await startImapServer({
    INBOX: [deals(1, 1), deals(2, 2), deals(3, 3), { raw: rawMessage({ n: 4, fromEmail: 'friend@example.com', subject: 'Hi' }) }],
    Junk: { 'special-use': '\\Junk', messages: [{ raw: rawMessage({ n: 5, fromName: 'Lea', fromEmail: 'lea@studio.example', subject: 'Dinner Friday?' }) }] },
    Trash: { 'special-use': '\\Trash', messages: [] },
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)
  const id = server.account.id

  const threads = await engine.senderThreads(id, ['NEWS@deals.example'])
  expect(threads.map((t) => [t.subject, t.sender, t.fromName])).toEqual([
    ['Sale 3', 'news@deals.example', 'Deals'],
    ['Sale 2', 'news@deals.example', 'Deals'],
    ['Sale 1', 'news@deals.example', 'Deals'],
  ])
  // Spam isn't live mail, so it never shows up among a sender's conversations; it has its own list.
  expect((await engine.spamThreads(id)).map((t) => [t.subject, t.sender])).toEqual([['Dinner Friday?', 'lea@studio.example']])

  const keep = threads.find((t) => t.subject === 'Sale 2')!.threadId
  const moves = await engine.scrub(id, { sender: 'news@deals.example' }, 'trash', 0, [keep])
  expect(moves.map((m) => m.threadId)).not.toContain(keep)
  expect(moves).toHaveLength(2)
  expect((await engine.senderThreads(id, ['news@deals.example'])).map((t) => t.subject)).toEqual(['Sale 2'])
})
