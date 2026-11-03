import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ImapFlow } from 'imapflow'
import { openDatabase } from './db'
import { createImapEngine, type ImapEngineOptions } from './imap-engine'
import { pendingCount, queueFlags } from './pending-ops'
import type { SecretStore } from './secrets'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'
import { detectWake } from './wake'
import { watchInbox } from './watch'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const secrets = (id: string): SecretStore => ({ get: async (a) => (a === id ? USER.pass : null), set: async () => {}, delete: async () => {} })

type SyncEvent = Extract<EngineEvent, { type: 'syncState' }>
type ThreadsEvent = Extract<EngineEvent, { type: 'threadsChanged' }>

async function pushHarness(folders: Parameters<typeof startImapServer>[0] = { INBOX: [{ raw: rawMessage({ n: 1 }) }] }, options: ImapEngineOptions = {}) {
  const server = await startImapServer(folders)
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: secrets(server.account.id), wake: false, reconnectBackoffMs: [100, 200], newMailDebounceMs: 100, ...options })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  return { server, engine, events, account: server.account, db }
}

const until = async <T>(fn: () => T | undefined | false, timeoutMs = 8000): Promise<T> => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error('timed out')
}
const syncsDone = (events: EngineEvent[], from = 0) => events.slice(from).filter((e): e is SyncEvent => e.type === 'syncState' && e.state.status === 'idle').length
const announced = (events: EngineEvent[], from = 0) =>
  events.slice(from).flatMap((e) => (e.type === 'threadsChanged' && (e as ThreadsEvent).incoming ? (e as ThreadsEvent).upserts.map((t) => t.subject) : []))

describe('push over IDLE', () => {
  test('new mail syncs and is announced without anyone asking', async () => {
    const { server, engine, events, account } = await pushHarness()
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300) // watcher connects and enters IDLE

    const mark = events.length
    server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'Pushed in' }) })
    await until(() => announced(events, mark).length === 1)
    expect(announced(events, mark)).toEqual(['Pushed in'])
  })

  // hoodiecrow doesn't send untagged FETCH (flag changes) to idling sessions, so only the deletion is
  // pushed here; flags changed elsewhere are covered by sync.test.ts and arrive with the next sync.
  test('a deletion made in another client syncs without anyone asking', async () => {
    const { server, engine, events, account } = await pushHarness({ INBOX: [{ raw: rawMessage({ n: 1, subject: 'Keep' }) }, { raw: rawMessage({ n: 2, subject: 'Delete me' }) }] })
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300)

    const latest = () => events.filter((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!(e as ThreadsEvent).replaceAll).at(-1)!.upserts
    const other = await server.connect()
    await other.mailboxOpen('INBOX')
    await other.messageDelete({ header: { subject: 'Delete me' } })
    await other.logout()
    await until(() => latest().every((t) => t.subject !== 'Delete me'))
    expect(latest().map((t) => t.subject)).toEqual(['Keep'])
  })

  test('the first arrival after a deletion is still pushed', async () => {
    const { server, engine, events, account } = await pushHarness({ INBOX: [{ raw: rawMessage({ n: 1, subject: 'Keep' }) }, { raw: rawMessage({ n: 2, subject: 'Delete me' }) }] })
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300)

    const other = await server.connect()
    await other.mailboxOpen('INBOX')
    await other.messageDelete({ header: { subject: 'Delete me' } })
    await other.logout()
    await until(() => syncsDone(events) === 2)
    await Bun.sleep(300)

    // Back to the count the watcher saw before the deletion: it must still read as new mail.
    const mark = events.length
    server.append('INBOX', { raw: rawMessage({ n: 3, subject: 'After the deletion' }) })
    await until(() => announced(events, mark).length === 1, 4000)
    expect(announced(events, mark)).toEqual(['After the deletion'])
  })

  test('a burst of arrivals becomes one follow-up sync', async () => {
    const { server, engine, events, account } = await pushHarness()
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300)

    const mark = events.length
    for (const n of [2, 3, 4]) server.append('INBOX', { raw: rawMessage({ n, subject: `Burst ${n}` }) })
    await until(() => announced(events, mark).length === 3)
    await Bun.sleep(400)
    expect(syncsDone(events, mark)).toBe(1)
    expect(announced(events, mark).sort()).toEqual(['Burst 2', 'Burst 3', 'Burst 4'])
  })

  test('a push syncs just the inbox: no new connection, other folders untouched, body ready at once', async () => {
    const { server, engine, events, account } = await pushHarness({ INBOX: [{ raw: rawMessage({ n: 1 }) }], Other: [] })
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300) // watcher connects and enters IDLE
    const connectsBefore = server.connectionCount()

    // Arrives in a folder the watcher never looks at, so an inbox-only sync must leave it alone.
    server.append('Other', { raw: rawMessage({ n: 99, subject: 'In another folder' }) })
    const mark = events.length
    server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'Pushed in' }) })
    await until(() => announced(events, mark).length === 1)
    await Bun.sleep(200) // let anything else the push kicked off settle

    // The watcher's own IDLE connection did the work; nothing extra was opened for the push.
    expect(server.connectionCount()).toBe(connectsBefore)

    const list = events.filter((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)!
    expect(list.upserts.map((t) => t.subject)).toContain('Pushed in')
    expect(list.upserts.map((t) => t.subject)).not.toContain('In another folder')

    // The body was downloaded before announcing, not left for a later sync.
    const incoming = events.slice(mark).find((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.incoming)!
    expect(incoming.upserts[0]!.snippet).not.toBe('')
  })

  // lume-75z.8: old mail must never delay new mail. Bodies come down in a background backfill that a
  // push cuts in front of, so a mailbox with a long body backlog still announces new mail at once.
  test('a push during a big body backfill is synced and announced while old bodies are still missing', async () => {
    const TOTAL = 1500
    const { server, engine, events, account, db } = await pushHarness(
      { INBOX: Array.from({ length: TOTAL }, (_, i) => ({ raw: rawMessage({ n: i + 1, subject: `Message ${i + 1}`, text: `Body ${i + 1}` }) })) },
      { bodyLimit: TOTAL + 1, backfillBatch: 1 },
    )
    const missing = () => (db.query('SELECT count(*) n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)').get() as { n: number }).n
    let missingAtAnnouncement = -1
    engine.subscribe((batch) => {
      if (batch.some((e) => e.type === 'threadsChanged' && e.incoming)) missingAtAnnouncement = missing()
    })
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300) // watcher connects and enters IDLE
    expect(missing()).toBeGreaterThan(0) // the backfill is still going

    const mark = events.length
    const sent = Date.now()
    server.append('INBOX', { raw: rawMessage({ n: TOTAL + 1, subject: 'Pushed in', text: 'Fresh body' }) })
    await until(() => announced(events, mark).length === 1)
    expect(announced(events, mark)).toEqual(['Pushed in'])
    // Announced with its own body, ahead of hundreds of old ones still waiting their turn.
    expect(Date.now() - sent).toBeLessThan(2000)
    expect(missingAtAnnouncement).toBeGreaterThan(100)
    const incoming = events.slice(mark).find((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.incoming)!
    expect(incoming.upserts[0]!.snippet).toBe('Fresh body')

    // The backfill picks up again behind the push and finishes the job.
    await until(() => missing() === 0, 20_000)
  }, 30_000)

  // lume-75z.7: a folder damaged by the search-false bug (every link and message gone, checkpoint
  // left high) can have thousands of messages to repair. The inbox fast path must not let that turn
  // a push into a slow sync — it caps the repair (INBOX_REPAIR_LIMIT in imap-engine.ts) and leaves
  // the rest to the full, uncapped sync it asks for right after.
  test('a damaged inbox is repaired up to a limit on a push; the rest heals on the full sync it triggers', async () => {
    const TOTAL = 250
    const { server, engine, events, account, db } = await pushHarness({ INBOX: Array.from({ length: TOTAL }, (_, i) => ({ raw: rawMessage({ n: i + 1, subject: `Message ${i + 1}` }) })) })
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300) // watcher connects and enters IDLE
    expect((db.query('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(TOTAL)

    // The damage: every link and message gone, but the checkpoint (last_uid) untouched.
    db.run('DELETE FROM message_mailboxes')
    db.run('DELETE FROM messages')

    const mark = events.length
    server.append('INBOX', { raw: rawMessage({ n: TOTAL + 1, subject: 'Pushed in' }) })
    // The push's inbox-only sync: the new message, plus a capped batch of repair — not the whole folder.
    await until(() => syncsDone(events, mark) === 1)
    const afterPush = (db.query('SELECT count(*) n FROM messages').get() as { n: number }).n
    expect(afterPush).toBe(201) // 200 repaired (the cap) + the 1 new message
    expect(afterPush).toBeLessThan(TOTAL + 1)

    // Repairing something on the fast path asks for a full, uncapped sync right behind it.
    await until(() => (db.query('SELECT count(*) n FROM messages').get() as { n: number }).n === TOTAL + 1)
    expect((db.query('SELECT count(*) n FROM message_mailboxes').get() as { n: number }).n).toBe(TOTAL + 1)
  })

  test('pending local changes make a push fall back to a full sync', async () => {
    const { server, engine, events, account, db } = await pushHarness()
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300)

    const list = events.filter((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)!
    // Queued directly against the database, bypassing the engine's own setFlags (which would ask for
    // a full sync itself) — this simulates ops still waiting from an earlier failed replay.
    queueFlags(db, account.id, list.upserts[0]!.id, { starred: true })
    expect(pendingCount(db, account.id)).toBeGreaterThan(0)

    const mark = events.length
    server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'Pushed with pending ops' }) })
    await until(() => announced(events, mark).length === 1)
    // A full sync replays the queue and clears it; an inbox-only one would have left it queued.
    await until(() => pendingCount(db, account.id) === 0)
    const phases = events.slice(mark).flatMap((e) => (e.type === 'syncState' ? [e.state.phase] : []))
    expect(phases).toContain('Connecting')
  })

  test("the echo of our own archive and its Undo needs no sync; someone else's deletion still gets one", async () => {
    const { server, engine, events, account, db } = await pushHarness({
      INBOX: [{ raw: rawMessage({ n: 1, subject: 'Keep me' }) }, { raw: rawMessage({ n: 2, subject: 'Archive me' }) }, { raw: rawMessage({ n: 3, subject: 'Delete me' }) }],
      Archive: { 'special-use': '\\Archive', messages: [] },
    })
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300)
    const list = events.filter((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)!
    const id = list.upserts.find((t) => t.subject === 'Archive me')!.id
    const inboxUid = () => (db.query("SELECT mm.uid FROM message_mailboxes mm JOIN messages m ON m.id = mm.message_id JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE m.subject = 'Archive me' AND mb.path = 'INBOX'").get() as { uid: number } | null)?.uid

    // Archive, then Undo once it went up: IDLE reports the EXPUNGE and then the EXISTS, both ours.
    let mark = events.length
    engine.move(account.id, id, 'archive')
    await until(() => pendingCount(db, account.id) === 0 && !inboxUid())
    await Bun.sleep(400)
    engine.move(account.id, id, 'inbox')
    await until(() => pendingCount(db, account.id) === 0 && (inboxUid() ?? 0) > 2)
    await Bun.sleep(600)
    expect(events.slice(mark).filter((e) => e.type === 'syncState')).toEqual([])
    expect(announced(events, mark)).toEqual([])

    // Another client's deletion is no echo: it syncs, and the list loses it.
    mark = events.length
    const other = await server.connect()
    await other.mailboxOpen('INBOX')
    await other.messageDelete({ header: { subject: 'Delete me' } })
    await other.logout()
    await until(() => syncsDone(events, mark) === 1)
    const after = events.slice(mark).filter((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)!
    expect(after.upserts.map((t) => t.subject).sort()).toEqual(['Archive me', 'Keep me'])
    expect(announced(events, mark)).toEqual([])
  })

  test('reconnects after the connection drops and catches up on missed mail', async () => {
    const { server, engine, events, account } = await pushHarness()
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300)

    const mark = events.length
    await server.pause()
    server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'Arrived while down' }) })
    await until(() => events.slice(mark).some((e) => e.type === 'connection' && e.status === 'offline'))
    await Bun.sleep(350) // at least one failed reconnect attempt
    await server.resume()

    await until(() => announced(events, mark).includes('Arrived while down'))
    expect(events.slice(mark).some((e) => e.type === 'connection' && e.status === 'online')).toBe(true)
  })

  test('working offline stops push; going back online syncs what was missed', async () => {
    const { server, engine, events, account } = await pushHarness()
    engine.syncNow(account.id, false)
    await until(() => syncsDone(events) === 1)
    await Bun.sleep(300)

    engine.setOffline(true)
    const mark = events.length
    server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'Held while offline' }) })
    await Bun.sleep(800)
    expect(syncsDone(events, mark)).toBe(0)
    expect(events.slice(mark).some((e) => e.type === 'syncState')).toBe(false)

    engine.setOffline(false)
    await until(() => announced(events, mark).includes('Held while offline'))
  })

  test('a sync requested while one is running runs right after instead of being dropped', async () => {
    const { engine, events, account } = await pushHarness()
    engine.syncNow(account.id, false)
    engine.syncNow(account.id, true)
    await until(() => syncsDone(events) === 2)
    const finished = events.filter((e): e is SyncEvent => e.type === 'syncState' && e.state.status === 'idle')
    expect(finished.map((e) => e.manual)).toEqual([false, true])
  })
})

describe('watchInbox', () => {
  test('restart reconnects immediately and reports resumed', async () => {
    const server = await startImapServer({ INBOX: [] })
    cleanups.push(() => server.close())
    let resumed = 0
    let connects = 0
    const watcher = watchInbox({
      connect: async () => {
        connects++
        return server.connect()
      },
      onNewMail: () => {},
      onResumed: () => resumed++,
      backoffMs: [50],
    })
    cleanups.push(() => watcher.stop())
    await until(() => connects === 1)
    await Bun.sleep(200)
    watcher.restart()
    await until(() => resumed === 1)
    expect(connects).toBe(2)
  })

  test('stop cancels pending reconnects', async () => {
    const server = await startImapServer({ INBOX: [] })
    cleanups.push(() => server.close())
    await server.pause()
    let connects = 0
    const watcher = watchInbox({
      connect: async () => {
        connects++
        return server.connect()
      },
      onNewMail: () => {},
      onResumed: () => {},
      backoffMs: [50],
    })
    await until(() => connects >= 2)
    watcher.stop()
    const after = connects
    await Bun.sleep(300)
    expect(connects).toBe(after)
  })

  test('client() exposes the live connection once the inbox is open, and clears it on stop', async () => {
    const server = await startImapServer({ INBOX: [] })
    cleanups.push(() => server.close())
    const watcher = watchInbox({ connect: () => server.connect(), onNewMail: () => {}, onResumed: () => {}, backoffMs: [50] })
    cleanups.push(() => watcher.stop())
    expect(watcher.client()).toBeNull()
    await until(() => watcher.client() !== null)
    watcher.stop()
    expect(watcher.client()).toBeNull()
  })

  // hoodiecrow doesn't deliver untagged FETCH (flag changes) to idling sessions (see push.test.ts
  // above), so this drives watchInbox directly against a fake connection instead of a real server.
  test('a flags event with a uid batches into onFlags; one without falls back to onNewMail', async () => {
    const client = Object.assign(new EventEmitter(), {
      mailboxOpen: async () => ({ exists: 0 }),
      idle: async () => {},
      close: () => {},
      logout: async () => {},
    })
    const flagBatches: Array<Array<{ uid: number; flags: string[] }>> = []
    let newMail = 0
    const watcher = watchInbox({
      connect: async () => client as unknown as ImapFlow,
      onNewMail: () => newMail++,
      onFlags: (updates) => flagBatches.push(updates),
      onResumed: () => {},
      backoffMs: [50],
    })
    cleanups.push(() => watcher.stop())
    await until(() => watcher.client() !== null)

    // Two events land before the microtask that flushes them: they coalesce into one batch.
    client.emit('flags', { path: 'INBOX', seq: 1, uid: 42, flags: new Set(['\\Seen']) })
    client.emit('flags', { path: 'INBOX', seq: 2, uid: 43, flags: new Set(['\\Flagged']) })
    await until(() => flagBatches.length === 1)
    expect(flagBatches[0]).toEqual([
      { uid: 42, flags: ['\\Seen'] },
      { uid: 43, flags: ['\\Flagged'] },
    ])

    client.emit('flags', { path: 'INBOX', seq: 3, flags: new Set(['\\Answered']) }) // no uid to target
    await until(() => newMail === 1)
    expect(flagBatches.length).toBe(1) // the fallback didn't also feed a (uid-less) batch
  })
})

test('detectWake fires when the timer fires much later than scheduled', async () => {
  let clock = 0
  const wakes: number[] = []
  const stop = detectWake((slept) => wakes.push(slept), { intervalMs: 20, toleranceMs: 1000, now: () => clock })
  cleanups.push(stop)
  clock += 20
  await Bun.sleep(30)
  expect(wakes).toEqual([])
  clock += 60_000 // the process was suspended for a minute
  await Bun.sleep(30)
  expect(wakes.length).toBe(1)
  expect(wakes[0]!).toBeGreaterThan(50_000)
})
