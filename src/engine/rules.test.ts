import { afterEach, expect, test } from 'bun:test'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import type { MailRule } from './rules'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const server = await startImapServer({
    INBOX: [{ raw: rawMessage({ n: 1, fromEmail: 'alerts@ci.example', subject: 'Build failed' }) }, { raw: rawMessage({ n: 2, fromEmail: 'friend@example.com', subject: 'Lunch' }) }],
    Archive: { 'special-use': '\\Archive', messages: [] },
  })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  const sync = async () => {
    const from = events.length
    engine.syncNow(server.account.id, true)
    for (let i = 0; i < 300 && !events.slice(from).some((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error')); i++) await Bun.sleep(20)
    return events.slice(from)
  }
  engine.setAccounts([server.account])
  await sync()
  const inInbox = (subject: string) =>
    !!db
      .query(`SELECT 1 FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE m.subject = ? AND mb.special_use = '\\Inbox'`)
      .get(subject)
  return { engine, server, account: server.account, sync, inInbox, db }
}

const ciRule: MailRule = { id: 'r1', name: 'CI noise', enabled: true, match: { from: 'ci.example' }, actions: { moveTo: 'archive', markRead: true } }

test('a rule files new mail as it arrives, and it is not announced', async () => {
  const { engine, server, account, sync, inInbox } = await setup()
  await engine.saveRule(account.id, ciRule)
  server.append('INBOX', { raw: rawMessage({ n: 3, fromEmail: 'alerts@ci.example', subject: 'Build failed again' }) })
  server.append('INBOX', { raw: rawMessage({ n: 4, fromEmail: 'friend@example.com', subject: 'Dinner?' }) })
  const events = await sync()
  expect(inInbox('Build failed again')).toBe(false)
  expect(inInbox('Dinner?')).toBe(true)
  // Existing mail is left alone until the rule is run on it.
  expect(inInbox('Build failed')).toBe(true)
  const announced = events.filter((e) => e.type === 'threadsChanged' && e.incoming).flatMap((e) => (e.type === 'threadsChanged' ? e.upserts.map((t) => t.subject) : []))
  expect(announced).toEqual(['Dinner?'])
})

test('running a rule applies it to what is already in the Inbox', async () => {
  const { engine, account, inInbox } = await setup()
  await engine.saveRule(account.id, ciRule)
  expect(await engine.runRule(account.id, 'r1')).toBe(1)
  expect(inInbox('Build failed')).toBe(false)
  expect(inInbox('Lunch')).toBe(true)
})

test('a rule without conditions is refused', async () => {
  const { engine, account } = await setup()
  await expect(engine.saveRule(account.id, { ...ciRule, match: {} })).rejects.toThrow('Add at least one condition')
  expect(await engine.listRules(account.id)).toEqual([])
})
