import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { forwardCompatProblem, MIGRATIONS, openDatabase, type MailDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { createLocalLabel, deleteLocalLabel, listLocalLabels, localLabelId, setThreadLocalLabels, threadLocalLabels, updateLocalLabel } from './local-labels'
import { applyRules, saveRule } from './rules'
import { searchThreads } from './search'
import type { SecretStore } from './secrets'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import { seedAccount, seedMailbox } from './testing/seed'
import { listRevision, loadLabels, loadThreads, loadView } from './threads'
import type { EngineEvent, MailEngine } from './types'

// ---------------------------------------------------------------------------
// Labels Jefi keeps itself for accounts without server labels (lume-kvp): stored in mail.db, so they
// survive syncs and restarts, and shown in the list, the label views, search and rules.
// ---------------------------------------------------------------------------

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const ACCOUNT = seedAccount('acct')

function seeded() {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  const ids = seedMailbox(db, ACCOUNT.id, ACCOUNT.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 3, subject: 'Hello' })
  const threads = loadThreads(db, ACCOUNT.id)
  const idOf = (subject: string) => threads.find((t) => t.subject === subject)!.id
  return { db, ids, idOf }
}

const labelsOf = (db: MailDatabase, id: string) => loadThreads(db, ACCOUNT.id).find((t) => t.id === id)?.labels

test('a label is created once per name, listed, renamed and deleted', () => {
  const { db } = seeded()
  const work = createLocalLabel(db, ACCOUNT.id, { id: localLabelId(ACCOUNT.id, 'w'), name: ' Work ', color: 'green' })!
  expect(work).toEqual({ id: 'lb:acct:w', label: 'Work', color: 'green' })
  // The same name (any case) or the same id gives back the label that's there.
  expect(createLocalLabel(db, ACCOUNT.id, { name: 'work' })).toEqual(work)
  expect(createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:w', name: 'Other' })).toEqual(work)
  expect(createLocalLabel(db, ACCOUNT.id, { name: '  ' })).toBeNull()
  createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:a', name: 'Admin' })
  expect(loadLabels(db, ACCOUNT.id).map((l) => l.label)).toEqual(['Admin', 'Work'])

  expect(updateLocalLabel(db, ACCOUNT.id, 'lb:acct:w', { name: 'Clients' })).toBe(true)
  // A name another label has is refused.
  expect(updateLocalLabel(db, ACCOUNT.id, 'lb:acct:w', { name: 'admin' })).toBe(false)
  expect(updateLocalLabel(db, ACCOUNT.id, 'lb:acct:nope', { name: 'X' })).toBe(false)
  expect(listLocalLabels(db, ACCOUNT.id)).toEqual([
    { id: 'lb:acct:a', label: 'Admin', color: 'purple' },
    { id: 'lb:acct:w', label: 'Clients', color: 'green' },
  ])
  // Another account never sees them.
  expect(listLocalLabels(db, 'other')).toEqual([])

  expect(deleteLocalLabel(db, ACCOUNT.id, 'lb:acct:a')).toBe(true)
  expect(deleteLocalLabel(db, ACCOUNT.id, 'lb:acct:a')).toBe(false)
  expect(loadLabels(db, ACCOUNT.id).map((l) => l.id)).toEqual(['lb:acct:w'])
})

test('a labelled conversation carries the label, fills its label view and is found by search', () => {
  const { db, idOf } = seeded()
  createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:w', name: 'Work' })
  createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:p', name: 'Personal' })
  const hello1 = idOf('Hello 1')
  const before = listRevision(db, ACCOUNT.id).rev

  // Ids that aren't this account's own labels are ignored (Gmail's, another account's, unknown ones).
  expect(setThreadLocalLabels(db, ACCOUNT.id, hello1, ['lb:acct:w', 'gm:acct:Travel', 'lb:other:x', 'lb:acct:gone'])).toBe(true)
  expect(setThreadLocalLabels(db, ACCOUNT.id, hello1, ['lb:acct:w'])).toBe(false)
  expect(labelsOf(db, hello1)).toEqual(['lb:acct:w'])
  expect(threadLocalLabels(db, ACCOUNT.id, hello1)).toEqual(['lb:acct:w'])
  // The list sees the change (a paged list asks what changed since its revision).
  expect(listRevision(db, ACCOUNT.id).rev).toBeGreaterThan(before)

  const page = loadView(db, ACCOUNT.id, 'label:lb:acct:w')!
  expect(page.threads.map((t) => t.subject)).toEqual(['Hello 1'])
  expect(loadView(db, ACCOUNT.id, 'label:lb:acct:p')!.threads).toEqual([])
  expect(searchThreads(db, ACCOUNT.id, 'label:work').map((t) => t.subject)).toEqual(['Hello 1'])

  // Exactly the labels asked for: swapping one for the other.
  expect(setThreadLocalLabels(db, ACCOUNT.id, hello1, ['lb:acct:p'])).toBe(true)
  expect(labelsOf(db, hello1)).toEqual(['lb:acct:p'])
  expect(loadView(db, ACCOUNT.id, 'label:lb:acct:w')!.threads).toEqual([])

  // Deleting the label takes it off every conversation.
  const rev = listRevision(db, ACCOUNT.id).rev
  deleteLocalLabel(db, ACCOUNT.id, 'lb:acct:p')
  expect(labelsOf(db, hello1)).toEqual([])
  expect(listRevision(db, ACCOUNT.id).rev).toBeGreaterThan(rev)
})

test('a label stays on a message that is downloaded again, and works for one without a Message-ID', () => {
  const { db, ids, idOf } = seeded()
  createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:w', name: 'Work' })
  setThreadLocalLabels(db, ACCOUNT.id, idOf('Hello 2'), ['lb:acct:w'])

  // The server moved it elsewhere: the old row goes, a new one comes with the same Message-ID.
  const row = db.query('SELECT message_id, subject, date FROM messages WHERE id = ?').get(ids[1]!) as { message_id: string; subject: string; date: number }
  const box = db.query("SELECT id FROM mailboxes WHERE path = 'INBOX'").get() as { id: number }
  db.run('DELETE FROM messages WHERE id = ?', [ids[1]!])
  db.run("INSERT INTO messages (account_id, message_id, subject, from_email, date, snippet, seen) VALUES (?, ?, ?, 'ada@example.com', ?, '', 1)", [ACCOUNT.id, row.message_id, row.subject, row.date])
  const again = (db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, 99, ?)', [box.id, again])
  expect(loadThreads(db, ACCOUNT.id).find((t) => t.subject === 'Hello 2')!.labels).toEqual(['lb:acct:w'])

  // No Message-ID: labelled by its row.
  db.run('UPDATE messages SET message_id = NULL WHERE id = ?', [ids[2]!])
  const bare = loadThreads(db, ACCOUNT.id).find((t) => t.subject === 'Hello 3')!.id
  expect(setThreadLocalLabels(db, ACCOUNT.id, bare, ['lb:acct:w'])).toBe(true)
  expect(labelsOf(db, bare)).toEqual(['lb:acct:w'])
  expect(loadView(db, ACCOUNT.id, 'label:lb:acct:w')!.threads.map((t) => t.subject).sort()).toEqual(['Hello 2', 'Hello 3'])
})

test('a rule can put one of Jefi’s own labels on new mail', () => {
  const { db, ids } = seeded()
  createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:w', name: 'Work' })
  createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:p', name: 'Personal' })
  const rule = { id: 'r1', name: 'Hello', enabled: true, match: { subject: 'Hello 1' }, actions: { label: 'lb:acct:w' } }
  saveRule(db, ACCOUNT.id, rule)
  const hello1 = loadThreads(db, ACCOUNT.id).find((t) => t.subject === 'Hello 1')!.id
  setThreadLocalLabels(db, ACCOUNT.id, hello1, ['lb:acct:p'])
  applyRules(db, ACCOUNT.id, [rule], [ids[0]!])
  // Added to what it had, not in its place.
  expect(labelsOf(db, hello1)).toEqual(['lb:acct:p', 'lb:acct:w'])
})

test('a mail.db with local labels still opens in the build before them', () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-labels-`)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = openDatabase(`${dir}/mail.db`)
  seedMailbox(db, ACCOUNT.id, ACCOUNT.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 1, subject: 'Hello' })
  createLocalLabel(db, ACCOUNT.id, { id: 'lb:acct:w', name: 'Work' })
  expect(forwardCompatProblem(db, MIGRATIONS.slice(0, MIGRATIONS.length - 1))).toBeNull()
  db.close()
})

// --- Through the engine, against an IMAP server without labels ----------------------------------

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

const syncAndWait = async (engine: MailEngine, events: EngineEvent[], server: Server) => {
  const mark = events.length
  engine.syncNow(server.account.id, false)
  const started = Date.now()
  while (Date.now() - started < 8000) {
    const done = events.slice(mark).find((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error'))
    if (done?.type === 'syncState') {
      if (done.state.status !== 'idle') throw new Error(`sync ended ${done.state.status}: ${done.state.error}`)
      return
    }
    await Bun.sleep(20)
  }
  throw new Error('sync did not finish')
}

const lastLabels = (events: EngineEvent[]) => [...events].reverse().find((e) => e.type === 'labelsChanged') as Extract<EngineEvent, { type: 'labelsChanged' }> | undefined

test('labels made on an IMAP account outlive syncs and a restart, and never reach the server', async () => {
  const server = await startImapServer({
    INBOX: [{ raw: rawMessage({ n: 1, subject: 'Invoice' }) }, { raw: rawMessage({ n: 2, subject: 'Lunch' }) }],
    Archive: { 'special-use': '\\Archive', messages: [] },
  })
  const db = openDatabase(':memory:')
  cleanups.push(() => server.close(), () => db.close())
  const accountId = server.account.id
  const first = engineFor(server, db)
  await syncAndWait(first.engine, first.events, server)

  const id = localLabelId(accountId, 'fin')
  first.engine.createLabel(accountId, { id, label: 'Finance', color: 'amber' })
  expect(lastLabels(first.events)).toMatchObject({ accountId, gmail: false, labels: [{ id, label: 'Finance', color: 'amber' }] })
  const invoice = loadThreads(db, accountId).find((t) => t.subject === 'Invoice')!.id
  first.engine.setLabels(accountId, invoice, [id])
  expect(loadThreads(db, accountId).find((t) => t.id === invoice)!.labels).toEqual([id])

  // Archiving moves it on the server; the label goes with it.
  first.engine.move(accountId, invoice, 'archive')
  await syncAndWait(first.engine, first.events, server)
  await syncAndWait(first.engine, first.events, server)
  const archived = loadThreads(db, accountId).find((t) => t.subject === 'Invoice')!
  expect([archived.folder, archived.labels]).toEqual(['archive', [id]])
  expect(lastLabels(first.events)!.labels.map((l) => l.label)).toEqual(['Finance'])
  first.engine.dispose()

  // A restart lists it again and still shows it on the conversation.
  const second = engineFor(server, db)
  await syncAndWait(second.engine, second.events, server)
  expect(lastLabels(second.events)!.labels).toEqual([{ id, label: 'Finance', color: 'amber' }])
  const listed = [...second.events].reverse().find((e) => e.type === 'threadsChanged') as Extract<EngineEvent, { type: 'threadsChanged' }>
  expect(listed.upserts.find((t) => t.subject === 'Invoice')!.labels).toEqual([id])

  second.engine.renameLabel(accountId, id, 'Money')
  expect(lastLabels(second.events)!.labels.map((l) => l.label)).toEqual(['Money'])
  second.engine.deleteLabel(accountId, id)
  expect(lastLabels(second.events)!.labels).toEqual([])
  expect(loadThreads(db, accountId).find((t) => t.subject === 'Invoice')!.labels).toEqual([])

  // Nothing was stored on the server: no keywords on the message.
  const client = await server.connect()
  try {
    const lock = await client.getMailboxLock('Archive', { readOnly: true })
    try {
      const [message] = await client.fetchAll('1:*', { flags: true })
      expect([...message!.flags!].filter((f) => !f.startsWith('\\'))).toEqual([])
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
})
