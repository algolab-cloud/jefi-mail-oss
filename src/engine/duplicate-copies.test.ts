import { afterEach, describe, expect, test } from 'bun:test'
import type { ImapFlow } from 'imapflow'
import { openDatabase, type MailDatabase } from './db'
import { ensureAccount, listMailboxes, resetMailbox } from './mail-store'
import { applyResync, syncAccount } from './sync'
import { rawMessage, startImapServer } from './testing/imap-server'

// lume-6fz: one folder holding two server copies with the same Message-ID (common in Junk).
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

type Server = Awaited<ReturnType<typeof startImapServer>>

async function setup() {
  const raw = rawMessage({ n: 1, subject: 'Twice' })
  const server = await startImapServer({ INBOX: [{ raw }, { raw }, { raw: rawMessage({ n: 2 }) }] })
  const client = await server.connect()
  const db = openDatabase(':memory:')
  ensureAccount(db, server.account.id, server.account.email)
  cleanups.push(() => server.close(), () => client.logout().catch(() => client.close()), () => db.close())
  return { server, client, db, accountId: server.account.id }
}

const count = (db: MailDatabase, sql: string) => (db.query(sql).get() as { n: number }).n
const links = (db: MailDatabase) => db.query('SELECT uid, message_id FROM message_mailboxes ORDER BY uid').all() as Array<{ uid: number; message_id: number }>
const aliases = (db: MailDatabase) => db.query('SELECT uid, message_id FROM mailbox_aliases ORDER BY uid').all() as Array<{ uid: number; message_id: number }>
const twice = (db: MailDatabase) => (db.query("SELECT id FROM messages WHERE subject = 'Twice'").get() as { id: number }).id

async function deleteUid(server: Server, uid: number) {
  const other = await server.connect()
  try {
    await other.mailboxOpen('INBOX')
    await other.messageDelete(String(uid), { uid: true })
  } finally {
    await other.logout()
  }
}

describe('duplicate copies in one folder', () => {
  test('the second copy is an alias, and later syncs fetch nothing and skip the folder', async () => {
    const { client, db, accountId } = await setup()
    const first = await syncAccount(client, db, accountId)
    expect(first.results[0]!.fetched).toBe(3)
    const id = twice(db)
    expect(links(db).map((l) => l.uid)).toEqual([1, 3])
    expect(links(db)[0]!.message_id).toBe(id)
    expect(aliases(db)).toEqual([{ uid: 2, message_id: id }])

    for (let i = 0; i < 3; i++) {
      const again = await syncAccount(client, db, accountId)
      expect(again.results).toEqual([])
      expect(again.foldersSkipped).toBe(1)
    }

    // A full sync (no STATUS skip) finds nothing to repair either: no flip-flop between the copies.
    const fetched: string[] = []
    const original = client.fetch.bind(client)
    ;(client as { fetch: ImapFlow['fetch'] }).fetch = ((range, query, options) => {
      if ((query as { envelope?: boolean }).envelope) fetched.push(String(range))
      return original(range, query, options)
    }) as ImapFlow['fetch']
    for (let i = 0; i < 3; i++) {
      const full = await syncAccount(client, db, accountId, { reconcile: true })
      expect(full.results[0]).toMatchObject({ fetched: 0, repaired: 0, removed: 0 })
      expect(links(db).map((l) => l.uid)).toEqual([1, 3])
      expect(aliases(db).map((a) => a.uid)).toEqual([2])
    }
    expect(fetched).toEqual([])
  })

  test('deleting the linked copy promotes the alias; deleting both unlinks the message', async () => {
    const { server, client, db, accountId } = await setup()
    await syncAccount(client, db, accountId)
    const id = twice(db)

    await deleteUid(server, 1)
    const result = await syncAccount(client, db, accountId)
    expect(result.results[0]).toMatchObject({ repaired: 0 })
    expect(links(db).filter((l) => l.message_id === id)).toEqual([{ uid: 2, message_id: id }])
    expect(aliases(db)).toEqual([])
    expect(count(db, "SELECT count(*) n FROM messages WHERE subject = 'Twice'")).toBe(1)
    expect((await syncAccount(client, db, accountId)).foldersSkipped).toBe(1)

    await deleteUid(server, 2)
    await syncAccount(client, db, accountId)
    expect(count(db, "SELECT count(*) n FROM messages WHERE subject = 'Twice'")).toBe(0)
    expect(links(db).map((l) => l.uid)).toEqual([3])
  })

  test('deleting the alias copy removes only the alias', async () => {
    const { server, client, db, accountId } = await setup()
    await syncAccount(client, db, accountId)
    const id = twice(db)
    await deleteUid(server, 2)
    const result = await syncAccount(client, db, accountId)
    expect(result.results[0]).toMatchObject({ removed: 1, repaired: 0 })
    expect(links(db).filter((l) => l.message_id === id)).toEqual([{ uid: 1, message_id: id }])
    expect(aliases(db)).toEqual([])
    expect((await syncAccount(client, db, accountId)).foldersSkipped).toBe(1)
  })

  test('QRESYNC counts aliases and applies VANISHED with the same promote rule', async () => {
    const { client, db, accountId } = await setup()
    await syncAccount(client, db, accountId)
    const id = twice(db)
    const inbox = listMailboxes(db, accountId).find((b) => b.path === 'INBOX')!
    // The server has 2 left at or below uid 3: the count adds up only with the alias counted.
    const result = applyResync(db, accountId, inbox, 3, 2, { vanished: new Set([1]), flags: new Map([[2, ['\\Seen']]]) })
    expect(result).toMatchObject({ removed: 1 })
    expect(links(db).filter((l) => l.message_id === id)).toEqual([{ uid: 2, message_id: id }])
    expect(aliases(db)).toEqual([])
  })

  test('a UIDVALIDITY reset clears aliases', async () => {
    const { client, db, accountId } = await setup()
    await syncAccount(client, db, accountId)
    const inbox = listMailboxes(db, accountId).find((b) => b.path === 'INBOX')!
    resetMailbox(db, inbox.id, 99)
    expect(aliases(db)).toEqual([])
  })
})
