import { afterEach, describe, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { ensureAccount, labelsOf, listMailboxes } from './mail-store'
import { gmailLabelId } from './pending-ops'
import type { SecretStore } from './secrets'
import { syncAccount, syncMailbox } from './sync'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import { isGmailAccount, loadLabels, loadThreads } from './threads'
import type { EngineEvent } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

// A Gmail-shaped mailbox: the same message (same X-GM-MSGID) appears in INBOX, All Mail and each label folder.
const offsite = rawMessage({ n: 1, subject: 'Offsite plan' })
const invoice = rawMessage({ n: 2, subject: 'Acme invoice' })
const gmailFolders = () => ({
  INBOX: [{ raw: offsite, 'X-GM-MSGID': '9001', 'X-GM-LABELS': ['Work'] }],
  '[Gmail]/All Mail': {
    'special-use': '\\All',
    messages: [
      { raw: offsite, 'X-GM-MSGID': '9001', 'X-GM-LABELS': ['\\Inbox', 'Work'] },
      { raw: invoice, 'X-GM-MSGID': '9002', 'X-GM-LABELS': ['Clients/Acme'], flags: ['\\Seen'] },
    ],
  },
  '[Gmail]/Sent Mail': { 'special-use': '\\Sent', messages: [] },
  Work: [{ raw: offsite, 'X-GM-MSGID': '9001', 'X-GM-LABELS': ['Work'] }],
  'Clients/Acme': [{ raw: invoice, 'X-GM-MSGID': '9002', 'X-GM-LABELS': ['Clients/Acme'] }],
})

async function gmailSetup() {
  const server = await startImapServer(gmailFolders(), { gmail: true })
  const db = openDatabase(':memory:')
  ensureAccount(db, server.account.id, server.account.email)
  cleanups.push(() => server.close(), () => db.close())
  return { server, db, accountId: server.account.id }
}

const serverLabels = async (server: Awaited<ReturnType<typeof startImapServer>>, path: string, subject: string) => {
  const client = await server.connect()
  try {
    const lock = await client.getMailboxLock(path, { readOnly: true })
    try {
      const all = await client.fetchAll('1:*', { envelope: true, labels: true })
      return [...(all.find((m) => m.envelope?.subject === subject)?.labels ?? [])].sort()
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

describe('Gmail', () => {
  test('messages are fetched once from the system folders; label folders become labels', async () => {
    const { server, db, accountId } = await gmailSetup()
    const client = await server.connect()
    cleanups.push(() => client.logout().catch(() => client.close()))

    const result = await syncAccount(client, db, accountId)
    expect(result.results.map((r) => r.path).sort()).toEqual(['INBOX', '[Gmail]/All Mail', '[Gmail]/Sent Mail'])
    expect((db.query('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(2)
    expect((db.query('SELECT count(*) n FROM message_mailboxes').get() as { n: number }).n).toBe(3)

    const threads = loadThreads(db, accountId).map((t) => [t.subject, t.folder, t.labels])
    expect(threads.sort()).toEqual([
      ['Acme invoice', 'archive', [gmailLabelId(accountId, 'Clients/Acme')]],
      ['Offsite plan', 'inbox', [gmailLabelId(accountId, 'Work')]],
    ])
    expect(loadLabels(db, accountId).map((l) => l.label)).toEqual(['Clients/Acme', 'Work'])
  })

  test('a sync with nothing changed skips the system folders and never asks STATUS of a label folder', async () => {
    const { server, db, accountId } = await gmailSetup()
    const client = await server.connect()
    cleanups.push(() => client.logout().catch(() => client.close()))
    await syncAccount(client, db, accountId)

    const asked: string[] = []
    const original = client.status.bind(client)
    ;(client as { status: typeof client.status }).status = ((path, query) => {
      asked.push(String(path))
      return original(path, query)
    }) as typeof client.status
    const result = await syncAccount(client, db, accountId)
    expect(result.results).toEqual([])
    expect(result.foldersSkipped).toBe(3)
    expect(asked.sort()).toEqual(['INBOX', '[Gmail]/All Mail', '[Gmail]/Sent Mail'])
  })

  test('changing labels in Jefi updates X-GM-LABELS on the server and survives the next sync', async () => {
    const { server, db, accountId } = await gmailSetup()
    const engine = createImapEngine({
      database: () => db,
      secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} } satisfies SecretStore,
      wake: false,
      watch: false,
      newMailDebounceMs: 30,
    })
    const events: EngineEvent[] = []
    engine.subscribe((b) => events.push(...b))
    engine.setAccounts([server.account])
    cleanups.push(() => engine.dispose())
    const synced = async () => {
      const mark = events.length
      engine.syncNow(server.account.id, false)
      for (let i = 0; i < 300; i++) {
        if (events.slice(mark).some((e) => e.type === 'syncState' && e.state.status === 'idle')) return
        await Bun.sleep(25)
      }
      throw new Error('sync did not finish')
    }
    await synced()
    const labelEvent = events.find((e) => e.type === 'labelsChanged')
    expect(labelEvent && labelEvent.type === 'labelsChanged' ? labelEvent.labels.map((l) => l.id) : []).toEqual([
      gmailLabelId(accountId, 'Clients/Acme'),
      gmailLabelId(accountId, 'Work'),
    ])
    // The UI makes new labels on Gmail accounts server labels, so it's told which accounts those are.
    expect(labelEvent && labelEvent.type === 'labelsChanged' ? labelEvent.gmail : undefined).toBe(true)

    const thread = loadThreads(db, accountId).find((t) => t.subject === 'Offsite plan')!
    const mark = events.length
    engine.setLabels(accountId, thread.id, [gmailLabelId(accountId, 'Travel'), 'design' /* a Jefi-only label: ignored */])
    const { id } = db.query("SELECT id FROM messages WHERE subject = 'Offsite plan'").get() as { id: number }
    expect(labelsOf(db, id)).toEqual(['Travel'])

    for (let i = 0; i < 200 && (db.query('SELECT count(*) n FROM pending_ops').get() as { n: number }).n > 0; i++) await Bun.sleep(25)
    // Work removed, Travel added; the system labels (hoodiecrow adds \All for the folder) are untouched.
    expect(await serverLabels(server, '[Gmail]/All Mail', 'Offsite plan')).toEqual(['Travel', '\\All', '\\Inbox'])
    // It went up by itself, no sync; the label list (now with Travel) follows at once.
    for (let i = 0; i < 100 && !events.slice(mark).some((e) => e.type === 'labelsChanged'); i++) await Bun.sleep(10)
    const relabelled = events.slice(mark).find((e) => e.type === 'labelsChanged')
    expect(relabelled && relabelled.type === 'labelsChanged' ? relabelled.labels.map((l) => l.label) : []).toEqual(['Clients/Acme', 'Travel', 'Work'])
    expect(events.slice(mark).some((e) => e.type === 'syncState')).toBe(false)

    await synced()
    expect(labelsOf(db, id)).toEqual(['Travel'])
    expect(loadThreads(db, accountId).find((t) => t.subject === 'Offsite plan')!.labels).toEqual([gmailLabelId(accountId, 'Travel')])
  })

  // lume-75z.7: a damaged INBOX (its link to a message lost, e.g. by the search-false bug) must not
  // duplicate that message on repair when it's still present under the same X-GM-MSGID elsewhere.
  test('gap-fill relinks a message still present in All Mail instead of duplicating it', async () => {
    const { server, db, accountId } = await gmailSetup()
    const client = await server.connect()
    cleanups.push(() => client.logout().catch(() => client.close()))
    await syncAccount(client, db, accountId)
    const { id: messageId } = db.query("SELECT id FROM messages WHERE subject = 'Offsite plan'").get() as { id: number }
    expect((db.query('SELECT count(*) n FROM message_mailboxes WHERE message_id = ?').get(messageId) as { n: number }).n).toBe(2)

    // Only the INBOX copy is damaged; the message survives (still linked from All Mail), so it was
    // never orphaned or deleted — just missing from this one folder.
    const inboxBox = listMailboxes(db, accountId).find((b) => b.path === 'INBOX')!
    db.run('DELETE FROM message_mailboxes WHERE mailbox_id = ? AND message_id = ?', [inboxBox.id, messageId])
    expect((db.query('SELECT count(*) n FROM message_mailboxes WHERE message_id = ?').get(messageId) as { n: number }).n).toBe(1)

    const result = await syncMailbox(client, db, accountId, inboxBox)
    expect(result.repaired).toBe(1)
    // Relinked to the same row — not a duplicate.
    expect((db.query('SELECT count(*) n FROM messages WHERE gm_msgid = ?').get('9001') as { n: number }).n).toBe(1)
    const links = db.query('SELECT mb.path FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = ? ORDER BY mb.path').all(messageId) as Array<{ path: string }>
    expect(links.map((l) => l.path)).toEqual(['INBOX', '[Gmail]/All Mail'])
  })

  test('non-Gmail servers have no server labels', async () => {
    const server = await startImapServer({ INBOX: [{ raw: rawMessage({ n: 1 }) }], Projects: [{ raw: rawMessage({ n: 2 }) }] })
    const db = openDatabase(':memory:')
    ensureAccount(db, server.account.id, server.account.email)
    cleanups.push(() => server.close(), () => db.close())
    const client = await server.connect()
    cleanups.push(() => client.logout().catch(() => client.close()))
    const result = await syncAccount(client, db, server.account.id)
    expect(result.results.map((r) => r.path).sort()).toEqual(['INBOX', 'Projects'])
    expect(loadLabels(db, server.account.id)).toEqual([])
    expect(isGmailAccount(db, server.account.id)).toBe(false)
  })
})
