import { afterEach, expect, test } from 'bun:test'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { parseQuery } from './search'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const server = await startImapServer({
    INBOX: [
      { raw: rawMessage({ n: 1, fromName: 'Ada', fromEmail: 'ada@example.com', subject: 'Invoice for March', text: 'Please find the quarterly invoice attached.', attachment: { filename: 'inv.pdf', content: 'x' } }) },
      { raw: rawMessage({ n: 2, fromName: 'Bob', fromEmail: 'bob@example.com', subject: 'Lunch', text: 'Tacos on Friday?' }), flags: ['\\Seen'] },
      { raw: rawMessage({ n: 3, fromName: 'Ada', fromEmail: 'ada@example.com', subject: 'Old note', text: 'Nothing here', date: new Date(Date.UTC(2020, 0, 1)) }) },
    ],
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)
  // Bodies come from the background backfill after the sync reports idle; body search needs them.
  const bodies = () => (db.query('SELECT count(*) n FROM bodies').get() as { n: number }).n
  for (let i = 0; i < 200 && bodies() < 3; i++) await Bun.sleep(20)
  const search = async (q: string) => (await engine.search(server.account.id, q)).map((t) => t.subject)
  return { search }
}

test('free text searches subjects and bodies, as prefixes', async () => {
  const { search } = await setup()
  expect(await search('invoice')).toEqual(['Invoice for March'])
  expect(await search('quarter')).toEqual(['Invoice for March'])
  expect(await search('tacos friday')).toEqual(['Lunch'])
  expect(await search('tacos march')).toEqual([])
})

test('operators narrow by sender, attachments, read state and date', async () => {
  const { search } = await setup()
  expect((await search('from:ada')).sort()).toEqual(['Invoice for March', 'Old note'])
  expect(await search('from:ada has:attachment')).toEqual(['Invoice for March'])
  expect(await search('is:read')).toEqual(['Lunch'])
  expect(await search('from:ada before:2021-01-01')).toEqual(['Old note'])
  expect(await search('subject:"for march"')).toEqual(['Invoice for March'])
})

test('the parser keeps unknown key:value pairs as text', () => {
  expect(parseQuery('from:ada re:budget hello').text).toEqual(['re:budget', 'hello'])
})
