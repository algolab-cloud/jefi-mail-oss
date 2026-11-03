import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDatabase, type MailDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { enqueueOutgoing, getOutgoing, markSending } from './outbox'
import { pendingCount } from './pending-ops'
import type { SecretStore } from './secrets'
import { selfSignedCert, startFakeSmtp } from './testing/fake-servers'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import { loadThreads } from './threads'
import type { EngineEvent, MailEngine } from './types'

// ---------------------------------------------------------------------------
// Crash recovery (lume-cu3.3): Jefi is killed with no chance to tidy up, then started again.
// Nothing the person wrote, queued or downloaded may be lost, and nothing may be done twice.
//
// A crash here is: stop using the engine and close the database handle, leaving whatever is on
// disk. Every restart opens the same file, as a new process would.
// ---------------------------------------------------------------------------

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const cert = selfSignedCert()
const secrets: SecretStore = { get: async () => USER.pass, set: async () => {}, delete: async () => {} }

const waitFor = async <T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000, every = 25): Promise<T> => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const value = await fn()
    if (value) return value
    await Bun.sleep(every)
  }
  throw new Error('timed out')
}

/** An installation on disk: the mail database survives, the engine and its handle do not. */
async function installation(options: { inbox?: number; smtp?: boolean; batchSize?: number; gmail?: boolean } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/jefi-recovery-`)
  const count = options.inbox ?? 3
  const imap = await startImapServer({
    INBOX: Array.from({ length: count }, (_, i) => ({
      raw: rawMessage({ n: i + 1, subject: `Message ${i + 1}` }),
      ...(options.gmail ? { 'X-GM-MSGID': String(10_000 + i), 'X-GM-LABELS': ['\\Inbox'] } : {}),
    })),
    Sent: { 'special-use': '\\Sent', messages: [] },
  }, { gmail: options.gmail })
  const smtp = options.smtp ? await startFakeSmtp({ cert, users: [{ user: USER.user, pass: USER.pass }] }) : null
  const account = {
    ...imap.account,
    name: 'Mara Lin',
    ...(options.gmail ? { provider: 'gmail' as const } : {}),
    ...(smtp ? { servers: { ...imap.account.servers, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'ssl' as const } } : {}),
  }
  cleanups.push(() => imap.close(), () => smtp?.close(), () => rmSync(dir, { recursive: true, force: true }))

  let live: { engine: MailEngine; db: MailDatabase } | null = null
  const boot = () => {
    const db = openDatabase(`${dir}/mail.db`)
    const engine = createImapEngine({
      database: () => db,
      secrets,
      wake: false,
      watch: false,
      draftSyncDelayMs: 60_000,
      ...(options.batchSize ? { batchSize: options.batchSize } : {}),
      connectOptions: { allowInvalidCerts: true, timeoutMs: 3000 },
    })
    const events: EngineEvent[] = []
    engine.subscribe((batch) => events.push(...batch))
    engine.setAccounts([account])
    live = { engine, db }
    return { engine, events, db }
  }
  /** The kill: no logout, no flush, no close of anything but our handle on the file. */
  const crash = () => {
    live?.engine.dispose()
    live?.db.close()
    live = null
  }
  cleanups.push(() => crash())
  return { imap, smtp, account, boot, crash, dir }
}

const syncedIdle = async (events: EngineEvent[], from = 0) =>
  waitFor(() => events.slice(from).some((e) => e.type === 'syncState' && e.state.status === 'idle'))

test('killed while composing: the draft is there on restart, down to the last autosave', async () => {
  const site = await installation()
  const first = site.boot()
  first.engine.saveDraft(site.account.id, 'draft-1', { to: ['kenji@example.com'], cc: [], bcc: [], subject: 'Half a thought', body: 'The rest later' })
  first.engine.saveDraft(site.account.id, 'draft-1', { to: ['kenji@example.com'], cc: [], bcc: [], subject: 'Half a thought', body: 'The rest later, with more' })
  site.crash()

  const after = site.boot()
  const drafts = loadThreads(after.db, site.account.id, { account: { name: 'Mara', email: USER.user } }).filter((t) => t.folder === 'drafts')
  expect(drafts).toHaveLength(1)
  expect(drafts[0]!.draft?.body).toBe('The rest later, with more')
  expect(drafts[0]!.draft?.subject).toBe('Half a thought')
})

test('killed mid-send: the message goes out after the restart, exactly once', async () => {
  const site = await installation({ smtp: true })
  const first = site.boot()
  const outgoing = { to: ['kenji@example.com'], cc: [], bcc: [], subject: 'Lunch?', body: 'Friday works' }
  // Queued and handed to SMTP, then the power goes: 'sending' is the state a crash leaves behind.
  enqueueOutgoing(first.db, { id: 'send-1', accountId: site.account.id, kind: 'message', threadId: 'send-1', mail: outgoing, messageId: '<crash-1@example.com>' })
  expect(markSending(first.db, 'send-1')).toBe(true)
  site.crash()

  const after = site.boot()
  // Opening the database is what recovers it; the engine then delivers.
  expect(getOutgoing(after.db, 'send-1')?.state).toBe('queued')
  after.engine.syncNow(site.account.id, true)
  await waitFor(() => getOutgoing(after.db, 'send-1')?.state === 'sent')
  const delivered = site.smtp!.received.filter((m) => m.includes('<crash-1@example.com>'))
  expect(delivered).toHaveLength(1)
})

test('killed mid-sync: the restart finishes the download, with nothing lost or doubled', async () => {
  // A mailbox big enough, in small batches, that the kill certainly lands between two of them.
  const TOTAL = 120
  const site = await installation({ inbox: TOTAL, batchSize: 3 })
  const first = site.boot()
  first.engine.syncNow(site.account.id, true)
  // Cut it off the moment mail starts landing, part-way through the mailbox.
  const count = () => (first.db.query('SELECT count(*) c FROM messages').get() as { c: number }).c
  await waitFor(() => count() > 0, 8000, 1)
  const atCrash = count()
  site.crash()
  // The point of the test: it really was cut off part-way through the mailbox.
  expect(atCrash).toBeGreaterThan(0)
  expect(atCrash).toBeLessThan(TOTAL)

  const after = site.boot()
  const mark = after.events.length
  after.engine.syncNow(site.account.id, true)
  await syncedIdle(after.events, mark)

  const rows = after.db.query('SELECT count(*) c FROM messages').get() as { c: number }
  expect(rows.c).toBe(TOTAL)
  // One link per message per mailbox: a resumed sync must not store the same UID twice.
  const links = after.db.query('SELECT count(*) c FROM message_mailboxes').get() as { c: number }
  expect(links.c).toBe(TOTAL)
  const subjects = (after.db.query('SELECT subject FROM messages ORDER BY id').all() as Array<{ subject: string }>).map((r) => r.subject)
  expect(new Set(subjects).size).toBe(TOTAL)
})

test('killed with changes made offline: they reach the server on the next sync', async () => {
  const site = await installation()
  const first = site.boot()
  first.engine.syncNow(site.account.id, true)
  await syncedIdle(first.events)
  const thread = loadThreads(first.db, site.account.id, {}).find((t) => t.subject === 'Message 2')!

  // Offline: the change is queued, never sent.
  first.engine.setOffline(true)
  first.engine.setFlags(site.account.id, thread.id, { starred: true })
  await waitFor(() => pendingCount(first.db, site.account.id) > 0)
  site.crash()

  const after = site.boot()
  expect(pendingCount(after.db, site.account.id)).toBeGreaterThan(0)
  const mark = after.events.length
  after.engine.syncNow(site.account.id, true)
  await syncedIdle(after.events, mark)
  expect(pendingCount(after.db, site.account.id)).toBe(0)

  // The server has the flag, not just our copy.
  const client = await site.imap.connect()
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      const flagged: string[] = []
      for await (const message of client.fetch('1:*', { envelope: true, flags: true })) {
        if (message.flags?.has('\\Flagged')) flagged.push(message.envelope?.subject ?? '')
      }
      expect(flagged).toEqual(['Message 2'])
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
})

test('Gmail-shaped provider recovers offline changes, a UIDVALIDITY reset, and an in-flight send', async () => {
  const site = await installation({ gmail: true, smtp: true })
  const first = site.boot()
  first.engine.syncNow(site.account.id, true)
  await syncedIdle(first.events)
  const thread = loadThreads(first.db, site.account.id, {}).find((candidate) => candidate.subject === 'Message 2')!

  first.engine.setOffline(true)
  first.engine.setFlags(site.account.id, thread.id, { starred: true })
  await waitFor(() => pendingCount(first.db, site.account.id) > 0)
  site.crash()

  const afterOffline = site.boot()
  const offlineMark = afterOffline.events.length
  afterOffline.engine.syncNow(site.account.id, true)
  await syncedIdle(afterOffline.events, offlineMark)
  expect(pendingCount(afterOffline.db, site.account.id)).toBe(0)
  const serverClient = await site.imap.connect()
  try {
    const lock = await serverClient.getMailboxLock('INBOX', { readOnly: true })
    try {
      const flagged: string[] = []
      for await (const message of serverClient.fetch('1:*', { envelope: true, flags: true })) {
        if (message.flags?.has('\\Flagged')) flagged.push(message.envelope?.subject ?? '')
      }
      expect(flagged).toEqual(['Message 2'])
    } finally {
      lock.release()
    }
  } finally {
    await serverClient.logout()
  }

  const before = afterOffline.db
    .query("SELECT uidvalidity FROM mailboxes WHERE account_id = ? AND path = 'INBOX'")
    .get(site.account.id) as { uidvalidity: number }
  site.imap.renumber('INBOX', before.uidvalidity + 7)
  const resetMark = afterOffline.events.length
  afterOffline.engine.syncNow(site.account.id, true)
  await syncedIdle(afterOffline.events, resetMark)
  const reset = afterOffline.db
    .query("SELECT uidvalidity, last_uid FROM mailboxes WHERE account_id = ? AND path = 'INBOX'")
    .get(site.account.id) as { uidvalidity: number; last_uid: number }
  expect(reset).toEqual({ uidvalidity: before.uidvalidity + 7, last_uid: 1002 })
  expect((afterOffline.db.query('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(3)
  expect((afterOffline.db.query('SELECT count(*) n FROM message_mailboxes').get() as { n: number }).n).toBe(3)

  enqueueOutgoing(afterOffline.db, {
    id: 'gmail-crash-send',
    accountId: site.account.id,
    kind: 'message',
    threadId: 'gmail-crash-send',
    mail: { to: ['kenji@example.com'], cc: [], bcc: [], subject: 'Provider recovery', body: 'Still exactly once' },
    messageId: '<gmail-crash-send@example.com>',
  })
  expect(markSending(afterOffline.db, 'gmail-crash-send')).toBe(true)
  site.crash()

  const afterSendCrash = site.boot()
  expect(getOutgoing(afterSendCrash.db, 'gmail-crash-send')?.state).toBe('queued')
  afterSendCrash.engine.syncNow(site.account.id, true)
  await waitFor(() => getOutgoing(afterSendCrash.db, 'gmail-crash-send')?.state === 'sent')
  expect(site.smtp!.received.filter((message) => message.includes('<gmail-crash-send@example.com>'))).toHaveLength(1)
})
