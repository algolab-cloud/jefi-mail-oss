import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ImapFlow } from 'imapflow'
import type { Account } from '../accounts'
import { createImapClient } from './connection'
import { openDatabase, type MailDatabase } from './db'
import { ensureAccount, listMailboxes, saveMailboxes } from './mail-store'
import { syncAccount, syncMailbox } from './sync'
import { watchInbox } from './watch'

// ---------------------------------------------------------------------------
// hoodiecrow has CONDSTORE and ENABLE but no QRESYNC, so the resync path is exercised against a
// stubbed ImapFlow: a tiny in-memory mailbox with mod-sequences that answers SELECT (QRESYNC ...)
// with VANISHED (EARLIER) and flag FETCHes the way imapflow surfaces them (expunge/flags events).
// ---------------------------------------------------------------------------

type Msg = { uid: number; flags: Set<string>; modseq: number }

class StubServer {
  uidvalidity = 7
  modseq = 10
  nextUid = 1
  messages: Msg[] = []
  expunged: Array<{ uid: number; modseq: number }> = []

  add(n: number) {
    for (let i = 0; i < n; i++) this.messages.push({ uid: this.nextUid++, flags: new Set(), modseq: ++this.modseq })
  }
  expunge(uid: number) {
    this.messages = this.messages.filter((m) => m.uid !== uid)
    this.expunged.push({ uid, modseq: ++this.modseq })
  }
  flag(uid: number, flag: string) {
    const message = this.messages.find((m) => m.uid === uid)!
    message.flags.add(flag)
    message.modseq = ++this.modseq
  }
}

const inRange = (range: string, uid: number, max: number) =>
  range.split(',').some((part) => {
    const [a, b] = part.split(':')
    const lo = Number(a)
    const hi = b === undefined ? lo : b === '*' ? Math.max(max, lo) : Number(b)
    return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi)
  })

class StubClient extends EventEmitter {
  enabled = new Set(['CONDSTORE', 'QRESYNC'])
  capabilities = new Set<string>(['CONDSTORE', 'QRESYNC'])
  mailbox: any = false
  calls: string[] = []
  failQresyncSelect = false
  dropQresync = false
  constructor(public server: StubServer) {
    super()
  }

  async getMailboxLock(path: string) {
    if (!this.mailbox || this.mailbox.path !== path) await this.mailboxOpen(path, { readOnly: true })
    return { path, release() {} }
  }

  async mailboxOpen(path: string, options: { readOnly?: boolean; uidValidity?: bigint; changedSince?: bigint } = {}) {
    const s = this.server
    const qresync = this.enabled.has('QRESYNC') && options.changedSince != null && options.uidValidity != null
    this.calls.push(qresync ? `SELECT QRESYNC ${options.changedSince}` : 'SELECT')
    if (qresync && this.failQresyncSelect) {
      this.mailbox = false
      throw new Error('NO [CLIENTBUG] bad QRESYNC')
    }
    const map: any = { path, exists: s.messages.length, uidValidity: BigInt(s.uidvalidity), uidNext: s.nextUid, highestModseq: BigInt(s.modseq), readOnly: true }
    if (qresync) {
      map.qresync = true
      if (options.uidValidity === BigInt(s.uidvalidity)) {
        const since = Number(options.changedSince)
        const gone = s.expunged.filter((e) => e.modseq > since).map((e) => e.uid)
        for (const uid of gone) this.emit('expunge', { path, uid, vanished: true, earlier: true })
        for (const m of s.messages) if (m.modseq > since) this.emit('flags', { path, uid: m.uid, flags: new Set(m.flags), modseq: BigInt(m.modseq) })
      }
      if (options.uidValidity !== map.uidValidity || this.dropQresync) map.qresync = false
    }
    this.mailbox = map
    return map
  }

  async search(query: { uid: string }) {
    this.calls.push(`SEARCH ${query.uid}`)
    const max = this.server.messages.at(-1)?.uid ?? 0
    const found = this.server.messages.filter((m) => inRange(query.uid, m.uid, max)).map((m) => m.uid)
    // `N:*` past the last UID still matches the last message (RFC 3501).
    if (!found.length && query.uid.endsWith(':*') && max) return [max]
    return found
  }

  async *fetch(range: string, _query: unknown, options: { changedSince?: bigint } = {}) {
    this.calls.push(`FETCH ${range}${options.changedSince != null ? ` CHANGEDSINCE ${options.changedSince}` : ''}`)
    const max = this.server.messages.at(-1)?.uid ?? 0
    for (const m of this.server.messages) {
      if (!inRange(range, m.uid, max)) continue
      if (options.changedSince != null && m.modseq <= Number(options.changedSince)) continue
      yield { uid: m.uid, flags: new Set(m.flags), modseq: BigInt(m.modseq), envelope: { subject: `m${m.uid}`, messageId: `<m${m.uid}@x>` }, size: 10, internalDate: new Date(0) }
    }
  }

  async list() {
    return [{ path: 'INBOX', delimiter: '/', flags: new Set(), specialUse: '\\Inbox' }]
  }
  async status() {
    return false
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

async function setup(initial = 5) {
  const server = new StubServer()
  server.add(initial)
  const client = new StubClient(server)
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  ensureAccount(db, 'acc', 'me@example.com')
  saveMailboxes(db, 'acc', [{ path: 'INBOX', delimiter: '/', specialUse: '\\Inbox' }])
  await syncMailbox(client as unknown as ImapFlow, db, 'acc', inbox(db))
  client.calls = []
  return { server, client, db, sync: (options = {}) => syncMailbox(client as unknown as ImapFlow, db, 'acc', inbox(db), options) }
}

const inbox = (db: MailDatabase) => listMailboxes(db, 'acc').find((b) => b.path === 'INBOX')!
const linked = (db: MailDatabase) =>
  (db.query('SELECT uid FROM message_mailboxes WHERE uid > 0 ORDER BY uid').all() as Array<{ uid: number }>).map((r) => r.uid)
const seen = (db: MailDatabase, uid: number) =>
  (db.query('SELECT m.seen FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id WHERE mm.uid = ?').get(uid) as { seen: number }).seen
const fullSearch = (client: StubClient) => client.calls.filter((c) => /^SEARCH 1:\d+$/.test(c))

describe('QRESYNC resync', () => {
  test('unlinks VANISHED UIDs and applies changed flags without listing every UID', async () => {
    const { server, client, db, sync } = await setup()
    const before = inbox(db).highestmodseq!
    server.expunge(2)
    server.flag(3, '\\Seen')
    const result = await sync()
    expect(result.removed).toBe(1)
    expect(result.flagsChanged).toBe(1)
    expect(linked(db)).toEqual([1, 3, 4, 5])
    expect(seen(db, 3)).toBe(1)
    expect(fullSearch(client)).toEqual([])
    expect(client.calls).toContain(`SELECT QRESYNC ${before}`)
    // No flag FETCH either: the SELECT's own answer carried the changes.
    expect(client.calls.filter((c) => c.startsWith('FETCH 1:'))).toEqual([])
    // The checkpoint is the HIGHESTMODSEQ the resync SELECT reported.
    expect(inbox(db).highestmodseq).toBe(server.modseq)
  })

  test('the checkpoint ignores modseqs imapflow bumped on an already-selected mailbox', async () => {
    const { server, client, db, sync } = await setup()
    const stored = inbox(db).highestmodseq!
    server.expunge(4)
    // An unsolicited FETCH MODSEQ raised imapflow's estimate past a VANISHED we never saw.
    client.mailbox.highestModseq = BigInt(server.modseq + 50)
    await sync()
    expect(client.calls[0]).toBe(`SELECT QRESYNC ${stored}`)
    expect(linked(db)).toEqual([1, 2, 3, 5])
    expect(inbox(db).highestmodseq).toBe(server.modseq)
  })

  test('new mail above the checkpoint is still fetched alongside a resync', async () => {
    const { server, client, db, sync } = await setup()
    server.expunge(1)
    server.add(2)
    const result = await sync()
    expect(result.fetched).toBe(2)
    expect(linked(db)).toEqual([2, 3, 4, 5, 6, 7])
    expect(fullSearch(client)).toEqual([])
  })
})

describe('QRESYNC fallbacks take the UID SEARCH path', () => {
  test('without QRESYNC enabled', async () => {
    const { server, client, db, sync } = await setup()
    client.enabled.delete('QRESYNC')
    server.expunge(2)
    await sync()
    expect(fullSearch(client)).toEqual(['SEARCH 1:5'])
    expect(client.calls.some((c) => c.startsWith('SELECT QRESYNC'))).toBe(false)
    expect(linked(db)).toEqual([1, 3, 4, 5])
  })

  test('without a stored modseq', async () => {
    const { server, client, db, sync } = await setup()
    db.run('UPDATE mailboxes SET highestmodseq = NULL')
    server.expunge(2)
    await sync()
    expect(fullSearch(client)).toEqual(['SEARCH 1:5'])
    expect(linked(db)).toEqual([1, 3, 4, 5])
  })

  test('when UIDVALIDITY changed', async () => {
    const { server, client, db, sync } = await setup()
    server.uidvalidity = 8
    const result = await sync()
    expect(result.reset).toBe(true)
    expect(client.calls.filter((c) => c.startsWith('SEARCH'))).toEqual(['SEARCH 1:*'])
    expect(linked(db)).toEqual([1, 2, 3, 4, 5])
  })

  test('when the QRESYNC SELECT fails', async () => {
    const { server, client, db, sync } = await setup()
    client.failQresyncSelect = true
    server.expunge(2)
    await sync()
    expect(fullSearch(client)).toEqual(['SEARCH 1:5'])
    expect(linked(db)).toEqual([1, 3, 4, 5])
  })

  test('when imapflow drops QRESYNC from the SELECT', async () => {
    const { server, client, db, sync } = await setup()
    client.dropQresync = true
    server.expunge(2)
    await sync()
    expect(fullSearch(client)).toEqual(['SEARCH 1:5'])
    expect(linked(db)).toEqual([1, 3, 4, 5])
  })

  test('when the local links do not add up to the server count, and gap-fills', async () => {
    const { client, db, sync } = await setup()
    // The trace of an old bad sync: a message still on the server, unlinked here.
    db.run('DELETE FROM message_mailboxes WHERE uid = 3')
    const result = await sync()
    expect(fullSearch(client)).toEqual(['SEARCH 1:5'])
    expect(result.repaired).toBe(1)
    expect(linked(db)).toEqual([1, 2, 3, 4, 5])
  })

  test('a VANISHED naming mail the server still counts unlinks nothing', async () => {
    const { client, db, sync } = await setup()
    // A misbehaving server reports UID 2 gone while EXISTS still counts it.
    client.on('flags', () => {})
    const open = client.mailboxOpen.bind(client)
    client.mailboxOpen = async (path, options) => {
      if (options?.changedSince != null) client.emit('expunge', { path, uid: 2, vanished: true, earlier: true })
      return open(path, options)
    }
    await sync()
    expect(fullSearch(client)).toEqual(['SEARCH 1:5'])
    expect(linked(db)).toEqual([1, 2, 3, 4, 5])
  })

  test('on the periodic reconcile', async () => {
    const { server, client, db } = await setup()
    server.expunge(2)
    await syncAccount(client as unknown as ImapFlow, db, 'acc', { reconcile: true })
    expect(fullSearch(client)).toEqual(['SEARCH 1:5'])
    expect(client.calls.some((c) => c.startsWith('SELECT QRESYNC'))).toBe(false)
    expect(linked(db)).toEqual([1, 3, 4, 5])
  })
})

describe('VANISHED on other connections', () => {
  test('the watcher syncs on a live VANISHED, not on a resync’s VANISHED (EARLIER)', async () => {
    const conn = new EventEmitter() as EventEmitter & Record<string, unknown>
    Object.assign(conn, { mailboxOpen: async () => ({ path: 'INBOX', exists: 3 }), idle: async () => {}, close() {}, logout: async () => {} })
    let syncs = 0
    const watcher = watchInbox({ connect: async () => conn as unknown as ImapFlow, onNewMail: () => syncs++, onResumed() {} } as Parameters<typeof watchInbox>[0])
    cleanups.push(() => watcher.stop())
    await Bun.sleep(10)
    conn.emit('expunge', { path: 'INBOX', uid: 2, vanished: true, earlier: true })
    expect(syncs).toBe(0)
    conn.emit('expunge', { path: 'INBOX', uid: 2, vanished: true, earlier: false })
    expect(syncs).toBe(1)
    conn.emit('expunge', { path: 'INBOX', seq: 1, vanished: false })
    expect(syncs).toBe(2)
  })

  test('a live VANISHED lowers the message count, as EXPUNGE does', () => {
    const account = { id: 'a', email: 'me@example.com', servers: { imapHost: 'localhost', imapPort: 1, imapSecurity: 'none' } } as unknown as Account
    const client = createImapClient(account, 'x')
    const mailbox = { path: 'INBOX', exists: 5 }
    ;(client as unknown as { mailbox: unknown }).mailbox = mailbox
    client.emit('expunge', { path: 'INBOX', uid: 9, vanished: true, earlier: false })
    client.emit('expunge', { path: 'INBOX', uid: 3, vanished: true, earlier: true })
    client.emit('expunge', { path: 'Other', uid: 4, vanished: true, earlier: false })
    expect(mailbox.exists).toBe(4)
  })
})
