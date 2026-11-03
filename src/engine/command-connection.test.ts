import { afterEach, describe, expect, test } from 'bun:test'
import { openDatabase } from './db'
import { createImapEngine, type ImapEngineOptions } from './imap-engine'
import type { SecretStore } from './secrets'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'

// lume-75z.5: one kept connection per account for syncs and on-demand work, and the engine's own
// poll cadence, which follows whether push is up.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const secrets = (id: string): SecretStore => ({ get: async (a) => (a === id ? USER.pass : null), set: async () => {}, delete: async () => {} })

type SyncEvent = Extract<EngineEvent, { type: 'syncState' }>
type ThreadsEvent = Extract<EngineEvent, { type: 'threadsChanged' }>

async function harness(options: ImapEngineOptions = {}) {
  const server = await startImapServer({ INBOX: [{ raw: rawMessage({ n: 1, subject: 'Old news', text: 'The full story, only on the server.' }) }], Other: [] })
  const db = openDatabase(':memory:')
  // No watcher and no backfill unless a test asks: every connection is then the command connection's.
  const engine = createImapEngine({ database: () => db, secrets: secrets(server.account.id), wake: false, watch: false, bodyLimit: 0, newMailDebounceMs: 50, ...options })
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
    await Bun.sleep(10)
  }
  throw new Error('timed out')
}
const syncs = (events: EngineEvent[]) => events.filter((e): e is SyncEvent => e.type === 'syncState')
const idles = (events: EngineEvent[]) => syncs(events).filter((e) => e.state.status === 'idle').length
const errors = (events: EngineEvent[]) => events.filter((e) => (e.type === 'syncState' && e.state.status === 'error') || (e.type === 'connection' && e.status !== 'online'))
/** Syncs that started as inbox-only (the fast path announces its phase up front). */
const inboxStarts = (events: EngineEvent[]) => syncs(events).filter((e) => e.state.status === 'syncing' && e.state.phase === 'Inbox').length
const fullStarts = (events: EngineEvent[]) => syncs(events).filter((e) => e.state.status === 'syncing' && e.state.phase === 'Connecting').length

describe('command connection', () => {
  test('consecutive full syncs share one connection', async () => {
    const { server, engine, events, account } = await harness()
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 1)
    expect(server.connectionCount()).toBe(1)

    server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'Second' }) })
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 2)
    expect(server.connectionCount()).toBe(1)
    expect(server.openConnections()).toBe(1)
    const list = events.filter((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)!
    expect(list.upserts.map((t) => t.subject)).toContain('Second')
  })

  test('a dropped connection is replaced and the next sync succeeds without an error', async () => {
    const { server, engine, events, account } = await harness()
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 1)

    server.dropConnections()
    await Bun.sleep(50)
    server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'After the drop' }) })
    const mark = events.length
    engine.syncNow(account.id, true)
    await until(() => idles(events.slice(mark)) === 1)
    expect(errors(events.slice(mark))).toEqual([])
    expect(server.connectionCount()).toBe(2)
  })

  test('a connection that dies under a sync is retried once on a fresh one', async () => {
    const { server, engine, events, account } = await harness()
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 1)

    // The socket goes away without the client noticing until the sync uses it.
    const mark = events.length
    engine.syncNow(account.id, true)
    server.dropConnections()
    await until(() => idles(events.slice(mark)) === 1)
    expect(errors(events.slice(mark))).toEqual([])
  })

  test('opening a conversation fetches its bodies on the kept connection', async () => {
    const { server, engine, events, account } = await harness()
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 1)
    const listed = events.filter((e): e is ThreadsEvent => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)!.upserts[0]!

    const opened = await engine.loadThread(account.id, listed.id)
    expect(opened!.messages[0]!.paragraphs.flat().join(' ')).toContain('The full story, only on the server.')
    expect(server.connectionCount()).toBe(1)
  })

  test('removing the account, going offline and disposing each close it', async () => {
    const { server, engine, events, account } = await harness()
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 1)
    expect(server.openConnections()).toBe(1)

    engine.setOffline(true)
    await until(() => server.openConnections() === 0)
    engine.setOffline(false)
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 2) // on a new connection
    expect(server.openConnections()).toBe(1)

    engine.dispose()
    await until(() => server.openConnections() === 0)
  })

  test('forgetting the account closes its connection', async () => {
    const { server, engine, events, account } = await harness()
    engine.syncNow(account.id, true)
    await until(() => idles(events) === 1)
    await engine.forgetAccount(account.id)
    await until(() => server.openConnections() === 0)
  })
})

describe('poll cadence', () => {
  test('nothing polls until auto-sync is on, and turning it off stops it', async () => {
    const { engine, events, account } = await harness({ poll: { tickMs: 10, fullMs: 60_000, inboxMs: 40 } })
    engine.syncNow(account.id, false)
    await until(() => idles(events) === 1)
    await Bun.sleep(200)
    expect(idles(events)).toBe(1)

    engine.setAutoSync(true)
    await until(() => idles(events) >= 3)
    engine.setAutoSync(false)
    await Bun.sleep(60) // a poll already under way finishes
    const stopped = idles(events)
    await Bun.sleep(200)
    expect(idles(events)).toBe(stopped)
  })

  test('with push down the inbox is polled at the fast rate', async () => {
    const { engine, events, account } = await harness({ poll: { tickMs: 10, fullMs: 60_000, inboxMs: 50 } })
    engine.syncNow(account.id, false)
    await until(() => idles(events) === 1)
    engine.setAutoSync(true)
    await Bun.sleep(400)
    expect(inboxStarts(events)).toBeGreaterThanOrEqual(3)
    expect(fullStarts(events)).toBe(1) // only the first sync
    expect(errors(events)).toEqual([])
  })

  test('with push up only the slow full sync runs', async () => {
    const { server, engine, events, account } = await harness({ watch: true, reconnectBackoffMs: [50], poll: { tickMs: 10, fullMs: 150, inboxMs: 20 } })
    engine.syncNow(account.id, false)
    await until(() => idles(events) === 1)
    await until(() => server.openConnections() === 2) // the watcher is in IDLE next to the command connection
    await Bun.sleep(100)
    const mark = events.length
    engine.setAutoSync(true)
    await Bun.sleep(500)
    const polled = events.slice(mark)
    expect(inboxStarts(polled)).toBe(0)
    expect(fullStarts(polled)).toBeGreaterThanOrEqual(2)
    expect(fullStarts(polled)).toBeLessThanOrEqual(4)
  })

  test('coming back to the app syncs when the last sync is stale, and only then', async () => {
    // A wide staleness window: under a loaded full suite, 100 ms could pass before the "too soon" check.
    const { engine, events, account } = await harness({ poll: { tickMs: 60_000, activatedMs: 1000 } })
    engine.syncNow(account.id, false)
    await until(() => idles(events) === 1)
    engine.appActivated() // auto-sync still off
    engine.setAutoSync(true)
    engine.appActivated() // too soon after the last one
    await Bun.sleep(150)
    expect(idles(events)).toBe(1)
    await Bun.sleep(1000)
    engine.appActivated()
    await until(() => idles(events) === 2)
  })
})
