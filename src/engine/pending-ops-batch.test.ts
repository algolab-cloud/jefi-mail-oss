import { afterEach, expect, test } from 'bun:test'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { pendingCount, queueFlags, queueMove, replayPendingOps } from './pending-ops'
import { senderThreads } from './scrub'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** A synced mailbox: 30 promotions and a friend in the Inbox, nothing replaying on its own. */
async function setup() {
  const deals = Array.from({ length: 30 }, (_, i) => ({ raw: rawMessage({ n: i + 1, fromEmail: 'news@deals.example', subject: `Sale ${i + 1}`, messageId: `<sale-${i + 1}@x>` }) }))
  const server = await startImapServer({
    INBOX: [...deals, { raw: rawMessage({ n: 99, fromEmail: 'friend@example.com', subject: 'Hi', messageId: '<hi@x>' }) }],
    Archive: { 'special-use': '\\Archive', messages: [] },
  })
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
  // Count the MOVE commands the replay sends.
  const moves: string[] = []
  const move = client.messageMove.bind(client)
  client.messageMove = (async (range: string, path: string, options: object) => {
    moves.push(range)
    return move(range, path, options as never)
  }) as typeof client.messageMove
  const subjectsIn = async (path: string) => {
    const lock = await client.getMailboxLock(path)
    try {
      const out: string[] = []
      for await (const m of client.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '')
      return out.sort()
    } catch {
      return []
    } finally {
      lock.release()
    }
  }
  return { db, client, moves, subjectsIn, id: server.account.id, server }
}

test('a mass archive goes up as one MOVE, and every message lands', async () => {
  const { db, client, moves, subjectsIn, id } = await setup()
  for (const t of senderThreads(db, id, ['news@deals.example'], 100)) queueMove(db, id, t.threadId, 'archive')
  expect(pendingCount(db, id)).toBe(30)
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 30, dropped: 0, remaining: 0, gone: 0 })
  expect(moves).toHaveLength(1)
  expect(await subjectsIn('INBOX')).toEqual(['Hi'])
  expect(await subjectsIn('Archive')).toHaveLength(30)
  // Locally, each one is linked to its new home on the server: no placeholder left to resolve.
  const placeholders = (db.query('SELECT count(*) AS n FROM message_mailboxes WHERE uid < 0').get() as { n: number }).n
  expect(placeholders).toBe(0)
})

test('a message deleted on the server meanwhile is let go, and the rest still move together', async () => {
  const { db, client, moves, subjectsIn, id } = await setup()
  for (const t of senderThreads(db, id, ['news@deals.example'], 100)) queueMove(db, id, t.threadId, 'archive')
  // Someone deletes one of them in another app before the replay.
  const lock = await client.getMailboxLock('INBOX')
  try {
    const [uid] = await client.search({ header: { 'message-id': '<sale-7@x>' } }, { uid: true }) as number[]
    await client.messageDelete(String(uid), { uid: true })
  } finally {
    lock.release()
  }
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 30, dropped: 0, remaining: 0, gone: 1 })
  expect(moves).toHaveLength(1)
  expect(await subjectsIn('Archive')).toHaveLength(29)
})

test('other changes in between keep their place: the run of moves splits around them', async () => {
  const { db, client, moves, subjectsIn, id } = await setup()
  const threads = senderThreads(db, id, ['news@deals.example'], 100)
  threads.slice(0, 10).forEach((t) => queueMove(db, id, t.threadId, 'archive'))
  const friend = senderThreads(db, id, ['friend@example.com'], 1)[0]!
  queueFlags(db, id, friend.threadId, { starred: true })
  threads.slice(10).forEach((t) => queueMove(db, id, t.threadId, 'archive'))
  const result = await replayPendingOps(client, db, id)
  expect(result).toMatchObject({ applied: 31, remaining: 0 })
  expect(moves).toHaveLength(2)
  expect(await subjectsIn('Archive')).toHaveLength(30)
  const lock = await client.getMailboxLock('INBOX')
  try {
    const [hi] = await client.fetchAll('1:*', { flags: true, envelope: true })
    expect(hi?.envelope?.subject).toBe('Hi')
    expect(hi?.flags?.has('\\Flagged')).toBe(true)
  } finally {
    lock.release()
  }
})
