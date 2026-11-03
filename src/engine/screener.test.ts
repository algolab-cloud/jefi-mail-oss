import { afterEach, expect, test } from 'bun:test'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const server = await startImapServer({
    INBOX: [{ raw: rawMessage({ n: 1, fromEmail: 'old@friend.example', subject: 'From before', date: new Date(Date.now() - 86_400_000) }) }],
    Trash: { 'special-use': '\\Trash', messages: [] },
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  const account = server.account
  const sync = async () => {
    const from = events.length
    engine.syncNow(account.id, true)
    for (let i = 0; i < 300 && !events.slice(from).some((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error')); i++) await Bun.sleep(20)
  }
  const threads = async () => {
    await Bun.sleep(1100) // snapshots are coalesced
    const list = events.filter((e) => e.type === 'threadsChanged' && e.replaceAll).at(-1)
    return list && list.type === 'threadsChanged' ? list.upserts : []
  }
  engine.setAccounts([account])
  await sync()
  return { engine, server, account, sync, threads }
}

test('new senders wait in the Screener; allow lets them in, block sends them to Trash', async () => {
  const { engine, server, account, sync, threads } = await setup()
  await engine.setScreener(account.id, true)
  await Bun.sleep(5)
  server.append('INBOX', { raw: rawMessage({ n: 2, fromEmail: 'stranger@new.example', subject: 'Hello there', date: new Date() }) })
  server.append('INBOX', { raw: rawMessage({ n: 3, fromEmail: 'spam@junk.example', subject: 'Win big', date: new Date() }) })
  await sync()
  const bySubject = async () => Object.fromEntries((await threads()).map((t) => [t.subject, { folder: t.folder, screened: !!t.screened }]))

  let state = await bySubject()
  expect(state['From before']).toEqual({ folder: 'inbox', screened: false })
  expect(state['Hello there']).toEqual({ folder: 'inbox', screened: true })
  expect(state['Win big']).toEqual({ folder: 'inbox', screened: true })

  await engine.screenSender(account.id, 'stranger@new.example', 'allow')
  expect(await engine.screenSender(account.id, 'spam@junk.example', 'block')).toBe(1)
  state = await bySubject()
  expect(state['Hello there']).toEqual({ folder: 'inbox', screened: false })
  expect(state['Win big']?.folder).toBe('trash')

  // Later mail from a blocked sender skips the Inbox entirely.
  server.append('INBOX', { raw: rawMessage({ n: 4, fromEmail: 'spam@junk.example', subject: 'Win bigger', date: new Date() }) })
  await sync()
  state = await bySubject()
  expect(state['Win bigger']?.folder).toBe('trash')
})
