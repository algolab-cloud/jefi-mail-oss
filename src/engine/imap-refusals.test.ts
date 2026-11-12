import { afterEach, expect, test } from 'bun:test'
import type { ImapFlow } from 'imapflow'
import { openDatabase, type MailDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { appendToSent } from './outbox'
import { pendingCount, queueDelete, queueFlags, queueMove, replayPendingOps } from './pending-ops'
import { senderThreads } from './scrub'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'

// What the queue does when the server says no. imapflow answers a NO/BAD (or a connection lost
// mid-command) to MOVE, STORE and EXPUNGE with `false`, not a throw: the replay must not take that
// for success, forget the change, and let the next sync bring the message back.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(options: { without?: string[] } = {}) {
  const deals = Array.from({ length: 5 }, (_, i) => ({ raw: rawMessage({ n: i + 1, fromEmail: 'news@deals.example', subject: `Sale ${i + 1}`, messageId: `<sale-${i + 1}@x>` }) }))
  const server = await startImapServer({
    INBOX: [
      ...deals,
      { raw: rawMessage({ n: 99, fromEmail: 'friend@example.com', subject: 'Hi', messageId: '<hi@x>' }) },
      // Marked for deletion by another mail app, which hasn't expunged it (yet).
      { raw: rawMessage({ n: 98, fromEmail: 'friend@example.com', subject: 'Theirs', messageId: '<theirs@x>' }), flags: ['\\Deleted'] },
    ],
    Archive: { 'special-use': '\\Archive', messages: [] },
    Trash: { 'special-use': '\\Trash', messages: [] },
  }, options)
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  for (let i = 0; i < 300 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)
  const client = await server.connect()
  cleanups.push(() => client.logout().catch(() => {}))
  const subjectsIn = async (path: string) => {
    const lock = await client.getMailboxLock(path)
    try {
      const out: string[] = []
      if (client.mailbox && client.mailbox.exists > 0) for await (const m of client.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
      return out.sort()
    } finally {
      lock.release()
    }
  }
  return { db, client, subjectsIn, id: server.account.id, server }
}

/** Subjects in INBOX with whether each carries \\Deleted, read on the test's own connection. */
const deletedFlags = async (client: ImapFlow) => {
  const lock = await client.getMailboxLock('INBOX')
  try {
    const out: Record<string, boolean> = {}
    for await (const m of client.fetch('1:*', { envelope: true, flags: true })) out[m.envelope?.subject ?? ''] = !!m.flags?.has('\\Deleted')
    return out
  } finally {
    lock.release()
  }
}

/** The server refuses this command: imapflow resolves it with `false`. */
const refuse = (client: ImapFlow, method: 'messageMove' | 'messageDelete' | 'messageFlagsAdd' | 'messageFlagsRemove') => {
  ;(client as unknown as Record<string, unknown>)[method] = async () => false
}

const queued = (db: MailDatabase) => db.query('SELECT kind, attempts, last_error FROM pending_ops ORDER BY id').all() as Array<{ kind: string; attempts: number; last_error: string | null }>
const threadOf = (db: MailDatabase, id: string, sender: string) => senderThreads(db, id, [sender], 100)

test('a refused MOVE stays queued with its attempt counted, and the message stays where the server has it', async () => {
  const { db, client, subjectsIn, id } = await setup()
  refuse(client, 'messageMove')
  const [hi] = threadOf(db, id, 'friend@example.com')
  queueMove(db, id, hi!.threadId, 'archive')
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 0, remaining: 1, dropped: 0 })
  expect(queued(db)).toEqual([{ kind: 'move', attempts: 1, last_error: expect.stringContaining('MOVE') }])
  expect(await subjectsIn('Archive')).toEqual([])
  expect(await subjectsIn('INBOX')).toContain('Hi')
})

test('a refused batch of MOVEs falls back to one at a time and keeps every op', async () => {
  const { db, client, id } = await setup()
  const moves: string[] = []
  ;(client as unknown as { messageMove: (range: string) => Promise<false> }).messageMove = async (range: string) => {
    moves.push(range)
    return false
  }
  for (const t of threadOf(db, id, 'news@deals.example')) queueMove(db, id, t.threadId, 'archive')
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 0, remaining: 5, dropped: 0 })
  // One batched MOVE, then each on its own.
  expect(moves).toHaveLength(6)
  expect(queued(db).map((r) => r.attempts)).toEqual([1, 1, 1, 1, 1])
})

test('a refused delete stays queued', async () => {
  const { db, client, subjectsIn, id } = await setup()
  refuse(client, 'messageDelete')
  const [hi] = threadOf(db, id, 'friend@example.com')
  queueDelete(db, id, hi!.threadId)
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 0, remaining: 1 })
  expect(queued(db)).toEqual([{ kind: 'delete', attempts: 1, last_error: expect.stringContaining('delete') }])
  expect(await subjectsIn('INBOX')).toContain('Hi')
})

test('refused flag changes stay queued', async () => {
  const { db, client, id } = await setup()
  refuse(client, 'messageFlagsAdd')
  refuse(client, 'messageFlagsRemove')
  const [hi] = threadOf(db, id, 'friend@example.com')
  queueFlags(db, id, hi!.threadId, { starred: true })
  queueFlags(db, id, hi!.threadId, { unread: true })
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 0, remaining: 2 })
  expect(queued(db).map((r) => [r.kind, r.attempts])).toEqual([
    ['flags', 1],
    ['flags', 1],
  ])
})

test('an op refused on every attempt is dropped after the last one, and counted', async () => {
  const { db, client, id } = await setup()
  refuse(client, 'messageMove')
  const [hi] = threadOf(db, id, 'friend@example.com')
  queueMove(db, id, hi!.threadId, 'archive')
  for (let i = 0; i < 4; i++) expect((await replayPendingOps(client, db, id)).dropped).toBe(0)
  const last = await replayPendingOps(client, db, id)
  expect(last).toMatchObject({ applied: 0, dropped: 1, remaining: 0, lost: [{ kind: 'move', folder: 'archive', count: 1 }] })
  expect(pendingCount(db, id)).toBe(0)
  // Undone here: back in the Inbox under its real UID, no placeholder left in Archive.
  const links = db.query("SELECT mb.path, mm.uid FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id JOIN messages m ON m.id = mm.message_id WHERE m.subject = 'Hi'").all()
  expect(links).toEqual([{ path: 'INBOX', uid: expect.any(Number) }])
  expect((links[0] as { uid: number }).uid).toBeGreaterThan(0)
})

test('a read or star change given up on flips back here', async () => {
  const { db, client, id } = await setup()
  refuse(client, 'messageFlagsAdd')
  const [hi] = threadOf(db, id, 'friend@example.com').filter((t) => t.subject === 'Hi')
  queueFlags(db, id, hi!.threadId, { starred: true })
  const flagged = () => (db.query("SELECT flagged FROM messages WHERE subject = 'Hi'").get() as { flagged: number }).flagged
  expect(flagged()).toBe(1)
  for (let i = 0; i < 5; i++) await replayPendingOps(client, db, id)
  expect(pendingCount(db, id)).toBe(0)
  expect(flagged()).toBe(0)
})

test('an empty range is still nothing to do, not a failure', async () => {
  const { db, client, id } = await setup()
  // imapflow resolves a command with nothing to act on with undefined: that must stay a no-op.
  ;(client as unknown as { messageFlagsAdd: () => Promise<undefined> }).messageFlagsAdd = async () => undefined
  const [hi] = threadOf(db, id, 'friend@example.com')
  queueFlags(db, id, hi!.threadId, { starred: true })
  expect(await replayPendingOps(client, db, id)).toMatchObject({ applied: 1, remaining: 0 })
})

/**
 * The server rebuilds INBOX between the queueing and the replay (new UIDVALIDITY, UIDs handed out
 * afresh): once the first message is gone, every UID shifts down one, so the UID the queued op
 * recorded for Hi now belongs to the message after it ("Theirs"), and "Intruder" arrives at the end.
 */
const rebuildInbox = (server: Awaited<ReturnType<typeof setup>>['server']) => {
  server.vanish('INBOX', 1)
  server.append('INBOX', { raw: rawMessage({ n: 100, subject: 'Intruder', messageId: '<intruder@x>' }) })
  server.renumber('INBOX', 4242, 1)
}

test('a queued delete is dropped, not sent, once its folder’s UIDVALIDITY has changed', async () => {
  const { db, client, subjectsIn, id, server } = await setup()
  const [hi] = threadOf(db, id, 'friend@example.com')
  queueDelete(db, id, hi!.threadId)
  rebuildInbox(server)
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 0, dropped: 1, remaining: 0 })
  // The message that inherited the UID is untouched, and so is Hi (the server wins; a sync brings it back).
  expect(await subjectsIn('INBOX')).toEqual(['Hi', 'Intruder', 'Sale 2', 'Sale 3', 'Sale 4', 'Sale 5', 'Theirs'])
})

test('a queued move is dropped once its source folder’s UIDVALIDITY has changed, and its placeholder goes', async () => {
  const { db, client, subjectsIn, id, server } = await setup()
  const deals = threadOf(db, id, 'news@deals.example')
  // A batch of moves and a single one: both check before they send.
  for (const t of deals.slice(0, 3)) queueMove(db, id, t.threadId, 'archive')
  queueFlags(db, id, deals[4]!.threadId, { starred: true })
  queueMove(db, id, threadOf(db, id, 'friend@example.com')[0]!.threadId, 'archive')
  rebuildInbox(server)
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 0, dropped: 5, remaining: 0 })
  expect(await subjectsIn('Archive')).toEqual([])
  expect(await subjectsIn('INBOX')).toEqual(['Hi', 'Intruder', 'Sale 2', 'Sale 3', 'Sale 4', 'Sale 5', 'Theirs'])
  // No message is left showing in Archive under a placeholder UID the server will never confirm.
  expect((db.query('SELECT count(*) AS n FROM message_mailboxes WHERE uid < 0').get() as { n: number }).n).toBe(0)
})

test('an op queued before UIDVALIDITY was recorded still replays as it always did', async () => {
  const { db, client, subjectsIn, id } = await setup()
  const [hi] = threadOf(db, id, 'friend@example.com')
  queueDelete(db, id, hi!.threadId)
  // As a row written by an older build: locations without uidvalidity.
  db.run("UPDATE pending_ops SET payload_json = json_remove(payload_json, '$.locations[0].uidvalidity')")
  expect(await replayPendingOps(client, db, id)).toMatchObject({ applied: 1, dropped: 0, remaining: 0 })
  expect(await subjectsIn('INBOX')).not.toContain('Hi')
})

test('a refused APPEND of the Sent copy rejects, like any other failure of it', async () => {
  const client = { append: async () => false } as unknown as ImapFlow
  await expect(appendToSent(client, 'Sent', Buffer.from('x'), new Date())).rejects.toThrow('APPEND to Sent')
})

// Without UIDPLUS there is no UID EXPUNGE: imapflow's messageDelete falls back to a plain EXPUNGE,
// which also erases every message another app marked \\Deleted in that folder. So only our own are
// marked, and the expunge is left to the server (or the app that marked the others).

test('without UIDPLUS a delete marks only our message \\Deleted and expunges nothing', async () => {
  const { db, client, id } = await setup({ without: ['UIDPLUS'] })
  const [hi] = threadOf(db, id, 'friend@example.com').filter((t) => t.subject === 'Hi')
  queueDelete(db, id, hi!.threadId)
  expect(await replayPendingOps(client, db, id)).toMatchObject({ applied: 1, remaining: 0 })
  const flags = await deletedFlags(client)
  // The other app's message is still there for it to deal with; ours waits for an expunge.
  expect(flags.Theirs).toBe(true)
  expect(flags.Hi).toBe(true)
  expect(flags['Sale 1']).toBe(false)
})

test('without MOVE or UIDPLUS a move copies, then marks the original \\Deleted, expunging nothing', async () => {
  const { db, client, subjectsIn, id } = await setup({ without: ['UIDPLUS', 'MOVE'] })
  const [hi] = threadOf(db, id, 'friend@example.com').filter((t) => t.subject === 'Hi')
  queueMove(db, id, hi!.threadId, 'archive')
  expect(await replayPendingOps(client, db, id)).toMatchObject({ applied: 1, remaining: 0 })
  expect(await subjectsIn('Archive')).toEqual(['Hi'])
  const flags = await deletedFlags(client)
  expect(flags.Theirs).toBe(true)
  expect(flags.Hi).toBe(true)
})

test('with UIDPLUS a delete still expunges just that UID', async () => {
  const { db, client, id } = await setup()
  const [hi] = threadOf(db, id, 'friend@example.com').filter((t) => t.subject === 'Hi')
  queueDelete(db, id, hi!.threadId)
  await replayPendingOps(client, db, id)
  const flags = await deletedFlags(client)
  expect(flags.Hi).toBeUndefined()
  expect(flags.Theirs).toBe(true)
})

test('a message another app marked \\Deleted is not shown, and one we only marked doesn’t come back on the next sync', async () => {
  const server = await startImapServer(
    {
      INBOX: [
        { raw: rawMessage({ n: 1, subject: 'Keep' }) },
        { raw: rawMessage({ n: 2, subject: 'Theirs' }), flags: ['\\Deleted'] },
        { raw: rawMessage({ n: 3, subject: 'Mine' }) },
      ],
      Trash: { 'special-use': '\\Trash', messages: [] },
    },
    { without: ['UIDPLUS'] },
  )
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  const sync = async () => {
    const mark = events.length
    engine.syncNow(server.account.id, true)
    for (let i = 0; i < 300 && !events.slice(mark).some((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error')); i++) await Bun.sleep(20)
  }
  const subjects = () => (db.query('SELECT subject FROM messages ORDER BY subject').all() as Array<{ subject: string }>).map((r) => r.subject)
  await sync()
  expect(subjects()).toEqual(['Keep', 'Mine'])
  const mine = db.query("SELECT id FROM messages WHERE subject = 'Mine'").get() as { id: number }
  engine.deleteForever(server.account.id, `${server.account.id}:m${mine.id}`)
  for (let i = 0; i < 300 && pendingCount(db, server.account.id) > 0; i++) await Bun.sleep(20)
  await sync()
  expect(subjects()).toEqual(['Keep'])
})
