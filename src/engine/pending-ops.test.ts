import { afterEach, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { pendingCount } from './pending-ops'
import type { SecretStore } from './secrets'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import { loadThreads } from './threads'
import type { EngineEvent, MailEngine } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

type Server = Awaited<ReturnType<typeof startImapServer>>
const secrets = (id: string): SecretStore => ({ get: async (a) => (a === id ? USER.pass : null), set: async () => {}, delete: async () => {} })

function engineFor(server: Server, db: MailDatabase) {
  const engine = createImapEngine({ database: () => db, secrets: secrets(server.account.id), wake: false, watch: false, newMailDebounceMs: 30 })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  engine.setAccounts([server.account])
  cleanups.push(() => engine.dispose())
  return { engine, events }
}

async function setup(options: Parameters<typeof startImapServer>[1] = {}) {
  const server = await startImapServer(
    {
      INBOX: [{ raw: rawMessage({ n: 1, subject: 'First' }) }, { raw: rawMessage({ n: 2, subject: 'Second' }) }],
      Archive: { 'special-use': '\\Archive', messages: [] },
      Trash: { 'special-use': '\\Trash', messages: [] },
    },
    options,
  )
  const db = openDatabase(':memory:')
  cleanups.push(() => server.close(), () => db.close())
  const { engine, events } = engineFor(server, db)
  await syncAndWait(engine, events, server)
  return { server, db, engine, events, accountId: server.account.id }
}

const syncAndWait = async (engine: MailEngine, events: EngineEvent[], server: Server, expect: 'idle' | 'error' = 'idle') => {
  const mark = events.length
  engine.syncNow(server.account.id, false)
  const started = Date.now()
  while (Date.now() - started < 8000) {
    const done = events.slice(mark).find((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error'))
    if (done && done.type === 'syncState') {
      if (done.state.status !== expect) throw new Error(`sync ended ${done.state.status}: ${done.state.error}`)
      return
    }
    await Bun.sleep(20)
  }
  throw new Error('sync did not finish')
}

/** What the server holds, read through a separate connection: subject → flags, per folder. */
async function serverState(server: Server) {
  const client = await server.connect()
  const state: Record<string, Record<string, string[]>> = {}
  try {
    for (const path of ['INBOX', 'Archive', 'Trash']) {
      state[path] = {}
      const lock = await client.getMailboxLock(path, { readOnly: true })
      try {
        if (client.mailbox && client.mailbox.exists > 0) {
          for (const m of await client.fetchAll('1:*', { envelope: true, flags: true })) state[path]![m.envelope!.subject!] = [...m.flags!].sort()
        }
      } finally {
        lock.release()
      }
    }
  } finally {
    await client.logout()
  }
  return state
}

const threadId = (db: MailDatabase, accountId: string, subject: string) => loadThreads(db, accountId).find((t) => t.subject === subject)!.id
type Checkpoint = { last_uid: number; uidnext: number | null; exists_count: number | null; synced_at: number | null }
const checkpoint = (db: MailDatabase, path: string) => db.query('SELECT last_uid, uidnext, exists_count, synced_at FROM mailboxes WHERE path = ?').get(path) as Checkpoint
const linksOf = (db: MailDatabase, subject: string) =>
  db.query('SELECT mb.path, mm.uid FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id JOIN messages m ON m.id = mm.message_id WHERE m.subject = ?').all(subject) as Array<{ path: string; uid: number }>
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await fn()) return
    await Bun.sleep(30)
  }
  throw new Error('condition not met')
}

test('read and star apply locally at once and reach the server on the next sync', async () => {
  const { server, db, engine, accountId } = await setup()
  const id = threadId(db, accountId, 'First')
  engine.setFlags(accountId, id, { unread: false })
  engine.setFlags(accountId, id, { starred: true })

  const local = loadThreads(db, accountId).find((t) => t.id === id)!
  expect([local.unread, local.starred]).toEqual([false, true])

  // The debounced follow-up sync replays the queue.
  await waitFor(() => pendingCount(db, accountId) === 0)
  await waitFor(async () => (await serverState(server)).INBOX!.First!.includes('\\Flagged'))
  expect((await serverState(server)).INBOX!.First).toEqual(['\\Flagged', '\\Seen'])
  expect((await serverState(server)).INBOX!.Second).toEqual([])

  engine.setFlags(accountId, id, { starred: false })
  await waitFor(async () => !(await serverState(server)).INBOX!.First!.includes('\\Flagged'))
})

test('reading or starring pushes just the flags, without a full sync or a new list', async () => {
  const { server, db, engine, events, accountId } = await setup()
  const mark = events.length
  engine.setFlags(accountId, threadId(db, accountId, 'First'), { unread: false })
  engine.setFlags(accountId, threadId(db, accountId, 'Second'), { starred: true })
  await waitFor(() => pendingCount(db, accountId) === 0)
  const state = await serverState(server)
  expect(state.INBOX!.First).toEqual(['\\Seen'])
  expect(state.INBOX!.Second).toEqual(['\\Flagged'])
  await Bun.sleep(100)
  // Nothing re-synced or re-published: SQLite and the UI already had the change.
  expect(events.slice(mark).map((e) => e.type)).toEqual([])
})

test('a move and a flag change go up by themselves: UIDPLUS settles the move, no sync follows', async () => {
  // No CONDSTORE (like Outlook.com): STATUS can't show flag changes, so it's the checkpoints that
  // must tell the next sync these folders need no re-read.
  const { server, db, engine, events, accountId } = await setup({ without: ['CONDSTORE'] })
  const inbox = checkpoint(db, 'INBOX')
  const archive = checkpoint(db, 'Archive')
  const mark = events.length
  engine.move(accountId, threadId(db, accountId, 'First'), 'archive')
  engine.setFlags(accountId, threadId(db, accountId, 'Second'), { starred: true })
  await waitFor(() => pendingCount(db, accountId) === 0)
  const state = await serverState(server)
  expect(Object.keys(state.Archive!)).toEqual(['First'])
  expect(state.INBOX!.Second).toEqual(['\\Flagged'])
  // The server's COPYUID gave the new UID: the placeholder is already swapped for it.
  const [link] = linksOf(db, 'First')
  expect(linksOf(db, 'First')).toEqual([{ path: 'Archive', uid: link!.uid }])
  expect(link!.uid).toBeGreaterThan(0)
  await Bun.sleep(150)
  // Nothing re-synced or re-published: SQLite and the UI already had the change.
  expect(events.slice(mark).map((e) => e.type)).toEqual([])
  // Both checkpoints kept in step, so the next sync finds the folders unchanged and skips them.
  expect(checkpoint(db, 'INBOX')).toEqual({ ...inbox, exists_count: inbox.exists_count! - 1 })
  expect(checkpoint(db, 'Archive')).toEqual({ ...archive, last_uid: link!.uid, uidnext: link!.uid + 1, exists_count: 1 })
  await syncAndWait(engine, events, server)
  expect(checkpoint(db, 'INBOX').synced_at).toBe(inbox.synced_at)
  expect(checkpoint(db, 'Archive').synced_at).toBe(archive.synced_at)
  expect(linksOf(db, 'First')).toEqual([{ path: 'Archive', uid: link!.uid }])
})

test('without UIDPLUS a move syncs just its target folder to link the new copy', async () => {
  const { server, db, engine, events, accountId } = await setup({ without: ['UIDPLUS'] })
  const inbox = checkpoint(db, 'INBOX')
  const archive = checkpoint(db, 'Archive')
  const mark = events.length
  engine.move(accountId, threadId(db, accountId, 'First'), 'archive')
  await waitFor(() => pendingCount(db, accountId) === 0 && linksOf(db, 'First').some((l) => l.uid > 0))
  expect(linksOf(db, 'First')).toEqual([{ path: 'Archive', uid: expect.any(Number) }])
  expect(Object.keys((await serverState(server)).Archive!)).toEqual(['First'])
  // The Archive was synced for it; the Inbox wasn't reopened, and no full sync ran.
  expect(checkpoint(db, 'Archive').exists_count).toBe(1)
  expect(checkpoint(db, 'Archive').synced_at).toBeGreaterThan(archive.synced_at!)
  expect(checkpoint(db, 'INBOX').synced_at).toBe(inbox.synced_at)
  expect(events.slice(mark).some((e) => e.type === 'syncState')).toBe(false)
  expect((db.query("SELECT count(*) n FROM messages WHERE subject = 'First'").get() as { n: number }).n).toBe(1)
})

test('a move undone before it went up leaves the message where it was, under its old UID', async () => {
  const { server, db, engine, events, accountId } = await setup()
  const id = threadId(db, accountId, 'First')
  const before = linksOf(db, 'First')
  const mark = events.length
  engine.move(accountId, id, 'archive')
  engine.move(accountId, id, 'inbox')
  expect(loadThreads(db, accountId).find((t) => t.subject === 'First')!.folder).toBe('inbox')
  await waitFor(() => pendingCount(db, accountId) === 0)
  expect(linksOf(db, 'First')).toEqual(before)
  const state = await serverState(server)
  expect(Object.keys(state.INBOX!).sort()).toEqual(['First', 'Second'])
  expect(state.Archive).toEqual({})
  await Bun.sleep(150)
  expect(events.slice(mark).map((e) => e.type)).toEqual([])
})

test('Undo after the archive went up moves it back under a new UID, and it is not new mail', async () => {
  const { server, db, engine, events, accountId } = await setup()
  const id = threadId(db, accountId, 'First')
  const before = linksOf(db, 'First')[0]!
  engine.move(accountId, id, 'archive')
  await waitFor(() => pendingCount(db, accountId) === 0)
  engine.move(accountId, threadId(db, accountId, 'First'), 'inbox')
  await waitFor(() => pendingCount(db, accountId) === 0)
  const [back] = linksOf(db, 'First')
  expect(back!.path).toBe('INBOX')
  expect(back!.uid).toBeGreaterThan(before.uid)
  expect(Object.keys((await serverState(server)).INBOX!).sort()).toEqual(['First', 'Second'])

  // The next sync (a real arrival alongside) announces only the arrival.
  server.append('INBOX', { raw: rawMessage({ n: 3, subject: 'Fresh news' }) })
  const mark = events.length
  await syncAndWait(engine, events, server)
  const incoming = events.slice(mark).flatMap((e) => (e.type === 'threadsChanged' && e.incoming ? e.upserts.map((t) => t.subject) : []))
  expect(incoming).toEqual(['Fresh news'])
  expect(linksOf(db, 'First')).toEqual([back!])
  expect((db.query("SELECT count(*) n FROM messages WHERE subject = 'First'").get() as { n: number }).n).toBe(1)
})

test('a move that fails on the server hands over to a full sync', async () => {
  const { server, db, engine, events, accountId } = await setup()
  // Deleted in webmail before the move goes up: the server wins, and a full sync looks around.
  const other = await server.connect()
  await other.mailboxOpen('INBOX')
  await other.messageDelete({ header: { subject: 'First' } })
  await other.logout()
  const mark = events.length
  engine.move(accountId, threadId(db, accountId, 'First'), 'archive')
  await waitFor(() => events.slice(mark).some((e) => e.type === 'syncState' && e.state.status === 'idle'))
  expect(pendingCount(db, accountId)).toBe(0)
  expect(loadThreads(db, accountId).map((t) => t.subject)).toEqual(['Second'])
  expect(events.slice(mark).flatMap((e) => (e.type === 'syncState' ? [e.state.phase] : []))).toContain('Connecting')
})

test('changes made offline survive a restart and replay when back online', async () => {
  const { server, db, engine, accountId } = await setup()
  engine.setOffline(true)
  engine.setFlags(accountId, threadId(db, accountId, 'Second'), { starred: true })
  engine.move(accountId, threadId(db, accountId, 'First'), 'archive')
  await Bun.sleep(150)
  expect(pendingCount(db, accountId)).toBe(2)
  expect(loadThreads(db, accountId).map((t) => [t.subject, t.folder]).sort()).toEqual([
    ['First', 'archive'],
    ['Second', 'inbox'],
  ])
  engine.dispose()

  const restarted = engineFor(server, db)
  await syncAndWait(restarted.engine, restarted.events, server)
  expect(pendingCount(db, accountId)).toBe(0)
  const state = await serverState(server)
  expect(Object.keys(state.INBOX!)).toEqual(['Second'])
  expect(state.INBOX!.Second).toEqual(['\\Flagged'])
  expect(Object.keys(state.Archive!)).toEqual(['First'])
})

test('a move shows in the target folder immediately and settles without duplicates', async () => {
  const { server, db, engine, events, accountId } = await setup()
  engine.move(accountId, threadId(db, accountId, 'First'), 'archive')
  expect(loadThreads(db, accountId).find((t) => t.subject === 'First')!.folder).toBe('archive')

  await waitFor(() => pendingCount(db, accountId) === 0)
  await syncAndWait(engine, events, server)
  await syncAndWait(engine, events, server)

  expect((db.query("SELECT count(*) n FROM messages WHERE subject = 'First'").get() as { n: number }).n).toBe(1)
  const links = db.query("SELECT mb.path, mm.uid FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id JOIN messages m ON m.id = mm.message_id WHERE m.subject = 'First'").all() as Array<{ path: string; uid: number }>
  expect(links.length).toBe(1)
  expect(links[0]!.path).toBe('Archive')
  expect(links[0]!.uid).toBeGreaterThan(0)
  expect(Object.keys((await serverState(server)).Archive!)).toEqual(['First'])
})

test('two moves before replay end up where the last one said', async () => {
  const { server, db, engine, accountId } = await setup()
  engine.setOffline(true)
  const id = threadId(db, accountId, 'First')
  engine.move(accountId, id, 'archive')
  engine.move(accountId, id, 'trash')
  engine.setFlags(accountId, id, { unread: false })
  expect(pendingCount(db, accountId)).toBe(2)
  engine.setOffline(false)

  const { engine: online, events } = engineFor(server, db)
  engine.dispose()
  await syncAndWait(online, events, server)
  const state = await serverState(server)
  expect(Object.keys(state.INBOX!)).toEqual(['Second'])
  expect(state.Archive).toEqual({})
  expect(state.Trash).toEqual({ First: ['\\Seen'] })
})

test('delete forever removes the message locally and on the server', async () => {
  const { server, db, engine, accountId } = await setup()
  engine.deleteForever(accountId, threadId(db, accountId, 'Second'))
  expect(loadThreads(db, accountId).map((t) => t.subject)).toEqual(['First'])
  await waitFor(async () => Object.keys((await serverState(server)).INBOX!).length === 1)
  expect(Object.keys((await serverState(server)).INBOX!)).toEqual(['First'])
})

test('the server wins: an op for a message already gone there is dropped, not retried forever', async () => {
  const { server, db, engine, events, accountId } = await setup()
  engine.setOffline(true)
  engine.move(accountId, threadId(db, accountId, 'First'), 'archive')

  // Someone deletes it in webmail before we replay.
  const other = await server.connect()
  await other.mailboxOpen('INBOX')
  await other.messageDelete({ header: { subject: 'First' } })
  await other.logout()

  engine.setOffline(false)
  await syncAndWait(engine, events, server)
  expect(pendingCount(db, accountId)).toBe(0)
  expect(loadThreads(db, accountId).map((t) => t.subject)).toEqual(['Second'])
  expect((await serverState(server)).Archive).toEqual({})
})

test('a failed connection keeps the queue for the next attempt', async () => {
  const { server, db, engine, events, accountId } = await setup()
  await server.pause()
  engine.setFlags(accountId, threadId(db, accountId, 'Second'), { unread: false })
  await syncAndWait(engine, events, server, 'error')
  expect(pendingCount(db, accountId)).toBe(1)

  await server.resume()
  await syncAndWait(engine, events, server)
  expect(pendingCount(db, accountId)).toBe(0)
  expect((await serverState(server)).INBOX!.Second).toEqual(['\\Seen'])
})
