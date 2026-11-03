import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { createImapEngine } from './imap-engine'
import type { SecretStore } from './secrets'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import type { EngineEvent, MailEngine } from './types'
import { storedAccountIds } from './mail-store'
import { seedAccount, seedMailbox } from './testing/seed'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const memorySecrets = (initial: Record<string, string> = {}): SecretStore => {
  const values = new Map(Object.entries(initial))
  return {
    get: async (id) => values.get(id) ?? null,
    set: async (id, secret) => void (secret ? values.set(id, secret) : values.delete(id)),
    delete: async (id) => void values.delete(id),
  }
}

async function harness(
  folders: Parameters<typeof startImapServer>[0],
  opts: {
    secret?: string | null
    db?: MailDatabase
    bodyLimit?: number
    backfillBatch?: number
    backfillPauseMs?: number
    backfillRetryMs?: number[]
    watch?: boolean
    openFile?: (path: string) => void
    /** Holds every connect after its Keychain read (the secret is already in hand) until it resolves. */
    gate?: Promise<void>
  } = {},
) {
  const server = await startImapServer(folders)
  const db = opts.db ?? openDatabase(':memory:')
  const secret = opts.secret === undefined ? USER.pass : opts.secret
  const stored = memorySecrets(secret ? { [server.account.id]: secret } : {})
  const gate = opts.gate
  const engine = createImapEngine({
    database: () => db,
    secrets: gate ? { ...stored, get: async (id) => {
      const secret = await stored.get(id)
      await gate
      return secret
    } } : stored,
    bodyLimit: opts.bodyLimit ?? 50,
    backfillBatch: opts.backfillBatch,
    backfillPauseMs: opts.backfillPauseMs,
    backfillRetryMs: opts.backfillRetryMs,
    watch: opts.watch,
    wake: false,
    openFile: opts.openFile,
  })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close())
  if (!opts.db) cleanups.push(() => db.close())
  cleanups.push(() => engine.dispose())
  return { server, db, engine, events, account: server.account }
}

const waitForSync = async (events: EngineEvent[], from = 0, timeoutMs = 10_000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const done = events.slice(from).find((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error'))
    if (done) return done as Extract<EngineEvent, { type: 'syncState' }>
    await Bun.sleep(20)
  }
  throw new Error('sync did not finish')
}

const lastSnapshot = (events: EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { type: 'threadsChanged' }> => e.type === 'threadsChanged' && !!e.replaceAll).at(-1)

const missingBodies = (db: MailDatabase) =>
  (db.query('SELECT count(*) n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)').get() as { n: number }).n

/** Bodies arrive after a sync, from the background backfill: waits for the list snapshot that has them. */
const waitForBackfill = async (events: EngineEvent[], db: MailDatabase, timeoutMs = 10_000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (missingBodies(db) === 0 && lastSnapshot(events)?.upserts.every((t) => t.snippet)) return lastSnapshot(events)!
    await Bun.sleep(20)
  }
  throw new Error('backfill did not finish')
}

test('syncs a real IMAP account into UI threads with progress, folders and bodies', async () => {
  const { engine, events, account, db } = await harness({
    INBOX: [
      { raw: rawMessage({ n: 1, subject: 'Lunch?', text: 'Friday works.\n\nSee you there.' }), flags: ['\\Seen'] },
      { raw: rawMessage({ n: 2, subject: 'Quarterly numbers', attachment: { filename: 'q3.csv', content: 'a,b' } }), flags: ['\\Flagged'] },
    ],
    Sent: { 'special-use': '\\Sent', messages: [{ raw: rawMessage({ n: 3, subject: 'Re: Lunch?' }), flags: ['\\Seen'] }] },
    Projects: [{ raw: rawMessage({ n: 4, subject: 'Only in a custom folder' }) }],
  })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  const done = await waitForSync(events)
  expect(done.state.status).toBe('idle')
  expect(done.manual).toBe(true)

  const phases = events.filter((e) => e.type === 'syncState').map((e) => (e as Extract<EngineEvent, { type: 'syncState' }>).state.phase)
  expect(phases).toEqual(expect.arrayContaining(['Connecting', 'Folders', 'Inbox', 'Sent', 'Projects']))

  const threads = (await waitForBackfill(events, db)).upserts
  // "Re: Lunch?" in Sent joins the inbox conversation (subject fallback: no reply headers here).
  expect(threads.filter((t) => !t.onlyInFolders).map((t) => [t.subject, t.folder, t.unread, t.starred, t.messages.length])).toEqual([
    ['Lunch?', 'inbox', false, false, 2],
    ['Quarterly numbers', 'inbox', true, true, 1],
  ])
  // Mail that lives only in a custom folder is listed under that folder, and the folder is published.
  expect(threads.filter((t) => t.onlyInFolders).map((t) => [t.subject, t.folders])).toEqual([['Only in a custom folder', ['Projects']]])
  const folders = events.filter((e) => e.type === 'foldersChanged').at(-1)
  expect(folders && 'folders' in folders ? folders.folders : null).toEqual([{ path: 'Projects', name: 'Projects', depth: 0 }])
  const lunch = threads.find((t) => t.subject === 'Lunch?')!
  // The list carries summaries (the snippet stands in for the body); opening loads the real thing.
  expect(lunch.messages[0]!.paragraphs).toEqual(['Friday works. See you there.'])
  const opened = await (engine as MailEngine).loadThread(account.id, lunch.id)
  expect(opened!.messages[0]!.paragraphs).toEqual(['Friday works.', 'See you there.'])
  expect(lunch.sender).toBe('Ada Lovelace (2)')
  expect(lunch.priority).toBe(true)
  expect(threads.find((t) => t.subject === 'Quarterly numbers')!.icons).toEqual(['paperclip'])
  // A complete list carries the whole Inbox's unread count, for badges the window alone would undercount.
  expect(lastSnapshot(events)!.inboxUnread).toBe(1)
  expect(events.some((e) => e.type === 'threadsChanged' && e.incoming)).toBe(false)
  engine.dispose()
})

test('announces only mail that arrived since the previous sync', async () => {
  const { server, engine, events, account } = await harness({ INBOX: [{ raw: rawMessage({ n: 1 }) }] })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  await waitForSync(events)

  server.append('INBOX', { raw: rawMessage({ n: 2, subject: 'Fresh news' }) })
  const mark = events.length
  engine.syncNow(account.id, false)
  await waitForSync(events, mark)
  const incoming = events.slice(mark).filter((e) => e.type === 'threadsChanged' && e.incoming) as Array<Extract<EngineEvent, { type: 'threadsChanged' }>>
  expect(incoming.flatMap((e) => e.upserts.map((t) => t.subject))).toEqual(['Fresh news'])
  engine.dispose()
})

test('stored mail is published again after a restart, before any sync', async () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  const first = await harness({ INBOX: [{ raw: rawMessage({ n: 1, subject: 'Kept locally' }) }] }, { db })
  first.engine.setAccounts([first.account])
  first.engine.syncNow(first.account.id, false)
  await waitForSync(first.events)

  const restarted = createImapEngine({ database: () => db, secrets: memorySecrets(), wake: false })
  cleanups.push(() => restarted.dispose())
  const events: EngineEvent[] = []
  restarted.subscribe((batch) => events.push(...batch))
  restarted.setAccounts([first.account])
  expect(lastSnapshot(events)!.upserts.map((t) => t.subject)).toEqual(['Kept locally'])
})

test('a missing password or a rejected sign-in ends the sync with an error, not a hang', async () => {
  const missing = await harness({ INBOX: [] }, { secret: null })
  missing.engine.setAccounts([missing.account])
  missing.engine.syncNow(missing.account.id, true)
  expect((await waitForSync(missing.events)).state.error).toMatch(/No saved password/)

  const wrong = await harness({ INBOX: [] }, { secret: 'not-the-password' })
  wrong.engine.setAccounts([wrong.account])
  wrong.engine.syncNow(wrong.account.id, true)
  expect((await waitForSync(wrong.events)).state.error).toMatch(/couldn't sign in/)

  // A failed sync can be retried: the account isn't stuck in "syncing".
  wrong.engine.syncNow(wrong.account.id, true)
  expect((await waitForSync(wrong.events, wrong.events.length - 1)).state.status).toBe('error')
})

test('forgetAccount removes stored mail and the secret, and the account stays gone', async () => {
  const { engine, events, account, db } = await harness({ INBOX: [{ raw: rawMessage({ n: 1 }) }] })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  await waitForSync(events)
  expect((db.query('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(1)
  await (engine as MailEngine).forgetAccount(account.id)
  expect((db.query('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(0)
  expect(storedAccountIds(db)).toEqual([])
  // A sync asked for afterwards, even alongside a stale account list, is a no-op: no row, no events.
  const before = events.length
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await Bun.sleep(200)
  expect(events.slice(before)).toEqual([])
  expect(storedAccountIds(db)).toEqual([])
})

test('a sync still connecting when its account is removed stores nothing and brings nothing back', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { engine, events, account, db } = await harness({ INBOX: [{ raw: rawMessage({ n: 1 }) }, { raw: rawMessage({ n: 2 }) }] }, { gate, watch: false })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  // Asked for again while the first waits on its connection: requeued behind it.
  engine.syncNow(account.id, true)
  expect(storedAccountIds(db)).toEqual([account.id])
  await engine.forgetAccount(account.id)
  expect(storedAccountIds(db)).toEqual([])
  const before = events.length
  release()
  await Bun.sleep(500)
  expect(storedAccountIds(db)).toEqual([])
  expect((db.query('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(0)
  expect((db.query('SELECT count(*) n FROM mailboxes').get() as { n: number }).n).toBe(0)
  expect(events.slice(before).filter((e) => e.type === 'syncState' || e.type === 'threadsChanged')).toEqual([])
})

test('purgeAccountsExcept drops stored accounts that are not kept, but never on an empty list or a served account', async () => {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  for (const id of ['orphan', 'kept', 'served']) seedMailbox(db, id, `${id}@example.com`, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 3, subject: id })
  const secrets = memorySecrets({ orphan: 'a', kept: 'b', served: 'c' })
  const engine = createImapEngine({ database: () => db, secrets, wake: false, watch: false })
  cleanups.push(() => engine.dispose())
  engine.setAccounts([seedAccount('served')])

  expect(await engine.purgeAccountsExcept([])).toEqual([])
  expect(storedAccountIds(db).sort()).toEqual(['kept', 'orphan', 'served'])

  // 'served' isn't in the list, but the engine is serving it: it stays.
  expect(await engine.purgeAccountsExcept(['kept'])).toEqual(['orphan'])
  expect(storedAccountIds(db).sort()).toEqual(['kept', 'served'])
  expect(db.query('SELECT account_id, count(*) n FROM messages GROUP BY account_id ORDER BY account_id').all()).toEqual([
    { account_id: 'kept', n: 3 },
    { account_id: 'served', n: 3 },
  ])
  expect(await secrets.get('orphan')).toBeNull()
  expect(await secrets.get('kept')).toBe('b')
  expect(await engine.purgeAccountsExcept(['kept'])).toEqual([])
})

const until = async <T>(fn: () => T | undefined | false, timeoutMs = 10_000): Promise<T> => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value) return value
    await Bun.sleep(10)
  }
  throw new Error('timed out')
}
const inbox = (count: number) => Array.from({ length: count }, (_, i) => ({ raw: rawMessage({ n: i + 1, subject: `Message ${i + 1}`, text: `Body ${i + 1}` }) }))

test('a full sync reports idle before any body downloads; snippets follow from the backfill', async () => {
  const { engine, events, account, db } = await harness({ INBOX: inbox(3) })
  let missingAtIdle = -1
  engine.subscribe((batch) => {
    if (batch.some((e) => e.type === 'syncState' && e.state.status === 'idle')) missingAtIdle = missingBodies(db)
  })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  const done = await waitForSync(events)
  expect(done.state.status).toBe('idle')
  // Headers only when the sync says it's done: the list is up, the bodies are still to come.
  expect(missingAtIdle).toBe(3)
  const idleAt = events.indexOf(done)
  expect(lastSnapshot(events.slice(0, idleAt))!.upserts.map((t) => t.snippet)).toEqual(['', '', ''])

  const filled = await waitForBackfill(events, db)
  expect(filled.upserts.map((t) => t.snippet).sort()).toEqual(['Body 1', 'Body 2', 'Body 3'])
  // Background work: the sync widget hears nothing more after the idle.
  expect(events.slice(idleAt + 1).some((e) => e.type === 'syncState')).toBe(false)
})

test('backfill yields to syncs and opened conversations, stops offline and on dispose, and never runs twice', async () => {
  const TOTAL = 1500
  // No watcher, so every open connection here is the command connection (syncs, opened conversations)
  // or the backfill's.
  const { server, engine, events, account, db } = await harness({ INBOX: inbox(TOTAL) }, { bodyLimit: TOTAL, backfillBatch: 1, watch: false })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  await waitForSync(events)
  await until(() => missingBodies(db) < TOTAL)

  // Two syncs and an opened conversation cut in; the backfill pauses for each and picks up behind them.
  const idles = () => events.filter((e) => e.type === 'syncState' && e.state.status === 'idle').length
  // The oldest listed conversation: far behind the backfill, which works newest first.
  const oldest = lastSnapshot(events)!.upserts.at(-1)!
  engine.syncNow(account.id, false)
  engine.syncNow(account.id, false)
  const opened = await engine.loadThread(account.id, oldest.id)
  expect(opened!.messages[0]!.paragraphs.flat().join(' ')).toContain(oldest.subject.replace('Message', 'Body'))
  await until(() => idles() === 3)

  await Bun.sleep(50) // any one-off connection a conversation opened mid-sync closes
  const before = missingBodies(db)
  let most = 0
  for (let i = 0; i < 40; i++) {
    most = Math.max(most, server.openConnections())
    await Bun.sleep(5)
  }
  // The kept command connection plus exactly one backfill.
  expect(most).toBe(2)
  expect(missingBodies(db)).toBeLessThan(before)

  engine.setOffline(true)
  await until(() => server.openConnections() === 0)
  await Bun.sleep(20)
  const paused = missingBodies(db)
  await Bun.sleep(300)
  expect(missingBodies(db)).toBe(paused)
  expect(paused).toBeGreaterThan(0)

  engine.setOffline(false)
  await until(() => missingBodies(db) < paused)

  engine.dispose()
  await until(() => server.openConnections() === 0)
  await Bun.sleep(20)
  const stopped = missingBodies(db)
  await Bun.sleep(300)
  expect(missingBodies(db)).toBe(stopped)
  expect(stopped).toBeGreaterThan(0)
}, 30_000)

test('backfill runs chain on one connection until every body is in, with no sync to restart them', async () => {
  const TOTAL = 35
  const { server, engine, events, account, db } = await harness({ INBOX: inbox(TOTAL) }, { bodyLimit: 10, backfillBatch: 5, backfillPauseMs: 5, watch: false })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  await waitForSync(events)
  const filled = await waitForBackfill(events, db)
  expect(filled.upserts.every((t) => t.snippet.startsWith('Body'))).toBe(true)
  // Four runs, one sync: nothing asked for them after the first.
  expect(events.filter((e) => e.type === 'syncState' && e.state.status === 'idle').length).toBe(1)
  // The kept command connection and one backfill connection, shared by every run.
  expect(server.connectionCount()).toBe(2)
  // Done: the backfill signs off, leaving the command connection.
  await until(() => server.openConnections() === 1)
})

test('a body the server never returns is skipped after a retry and holds nothing else up', async () => {
  const TOTAL = 30
  const GHOST = 15
  const { server, engine, events, account, db } = await harness({ INBOX: inbox(TOTAL) }, { bodyLimit: 8, backfillBatch: 4, backfillPauseMs: 5, watch: false })
  // Gone from the server between the sync listing it and the backfill asking for it.
  let vanished = false
  engine.subscribe((batch) => {
    if (vanished || !batch.some((e) => e.type === 'syncState' && e.state.status === 'idle')) return
    vanished = true
    server.vanish('INBOX', GHOST)
  })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  await waitForSync(events)
  await until(() => missingBodies(db) === 1)
  // No loop on the one that can't come: the backfill finishes and lets its connection go.
  await until(() => server.openConnections() === 1)
  const connections = server.connectionCount()
  await Bun.sleep(200)
  expect(server.connectionCount()).toBe(connections)
  expect(server.openConnections()).toBe(1)
  expect(missingBodies(db)).toBe(1)
  const ghost = lastSnapshot(events)!.upserts.find((t) => t.subject === `Message ${GHOST}`)!
  expect(ghost.snippet).toBe('')
})

test('a backfill whose connection drops retries on its own after a wait, warning once', async () => {
  const TOTAL = 300
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  cleanups.push(() => warn.mockRestore())
  const { server, engine, events, account, db } = await harness(
    { INBOX: inbox(TOTAL) },
    { bodyLimit: TOTAL, backfillBatch: 1, backfillPauseMs: 5, backfillRetryMs: [50], watch: false },
  )
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  await waitForSync(events)
  await until(() => missingBodies(db) < TOTAL)
  server.dropConnections()
  await until(() => missingBodies(db) === 0, 20_000)
  expect(events.filter((e) => e.type === 'syncState' && e.state.status === 'idle').length).toBe(1)
  expect(warn.mock.calls.filter((call) => String(call[0]).startsWith('backfill:')).length).toBe(1)
}, 30_000)

test('opening a conversation downloads bodies that background sync skipped', async () => {
  const { engine, events, account } = await harness(
    { INBOX: [{ raw: rawMessage({ n: 1, subject: 'Old news', text: 'The full story, only on the server.' }) }] },
    { bodyLimit: 0 },
  )
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  const listed = lastSnapshot(events)!.upserts[0]!

  const opened = await engine.loadThread(account.id, listed.id)
  expect(opened!.messages[0]!.bodyMissing).toBeUndefined()
  expect(opened!.messages[0]!.paragraphs.flat().join(' ')).toContain('The full story, only on the server.')
})

test('offline, a conversation without a stored body says it could not be downloaded', async () => {
  const { engine, events, account } = await harness({ INBOX: [{ raw: rawMessage({ n: 1, subject: 'Old news', text: 'Server only.' }) }] }, { bodyLimit: 0 })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  engine.setOffline(true)

  const opened = await engine.loadThread(account.id, lastSnapshot(events)!.upserts[0]!.id)
  expect(opened!.messages[0]!.paragraphs.flat().join(' ')).toContain("Couldn't download the rest of this message")
})

test('an opened conversation lists its attachments with sizes', async () => {
  const { engine, events, account } = await harness({
    INBOX: [{ raw: rawMessage({ n: 1, subject: 'Quarterly numbers', attachment: { filename: 'q3.csv', content: 'a,b' } }) }],
  })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  const listed = lastSnapshot(events)!.upserts[0]!
  expect(listed.messages[0]!.attachments).toBeUndefined()

  const opened = await engine.loadThread(account.id, listed.id)
  expect(opened!.messages[0]!.attachments).toEqual([{ name: 'q3.csv', size: '3 B', index: 0 }])
})

const INVITE_ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:board-1@example.com',
  'DTSTAMP:20260901T090000Z', 'DTSTART:20261001T150000Z', 'DTEND:20261001T160000Z', 'SUMMARY:Board meeting',
  'ORGANIZER:mailto:kenji@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:user@example.com', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n')
const ICS_NO_METHOD = INVITE_ICS.replace('METHOD:REQUEST\r\n', '')

const rawMime = (n: number, subject: string, contentType: string, parts: string[]) => [
  'From: Kenji <kenji@example.com>', 'To: user@example.com', `Subject: ${subject}`, `Message-ID: <mime-${n}@example.com>`,
  `Date: Thu, 0${n} Sep 2026 09:00:00 +0000`, 'MIME-Version: 1.0', `Content-Type: ${contentType}; boundary="b${n}"`, '',
  ...parts.flatMap((part) => [`--b${n}`, part]), `--b${n}--`, '',
].join('\r\n')

test('an invitation\'s calendar part is the invite card, not an attachment; a named .ics stays a file', async () => {
  const imip = rawMime(1, 'Invitation: Board meeting', 'multipart/alternative', [
    'Content-Type: text/plain; charset=utf-8\r\n\r\nYou are invited.',
    'Content-Type: text/html; charset=utf-8\r\n\r\n<p>You are invited.</p>',
    `Content-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\n${INVITE_ICS}`,
  ])
  // An .ics attached next to a PDF: the invite card shows it, the PDF keeps its index for downloading.
  const inviteFile = rawMime(2, 'Invite as a file', 'multipart/mixed', [
    'Content-Type: text/plain; charset=utf-8\r\n\r\nSee attached.',
    `Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="Board meeting.ics"\r\nContent-Disposition: attachment; filename="Board meeting.ics"\r\n\r\n${INVITE_ICS}`,
    'Content-Type: application/pdf; name="agenda.pdf"\r\nContent-Disposition: attachment; filename="agenda.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=',
  ])
  // A calendar export (no iTIP method) gets no invite card: the named file is all there is to open.
  const standalone = rawMime(3, 'Calendar export', 'multipart/mixed', [
    'Content-Type: text/plain; charset=utf-8\r\n\r\nHere is the calendar.',
    `Content-Type: text/calendar; charset=utf-8; name="Board meeting.ics"\r\nContent-Disposition: attachment; filename="Board meeting.ics"\r\n\r\n${ICS_NO_METHOD}`,
  ])
  const { db, engine, events, account } = await harness({ INBOX: [{ raw: imip }, { raw: inviteFile }, { raw: standalone }] })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  const threads = (await waitForBackfill(events, db)).upserts
  const bySubject = (subject: string) => threads.find((t) => t.subject === subject)!
  const open = async (subject: string) => (await engine.loadThread(account.id, bySubject(subject).id))!.messages[0]!

  expect(bySubject('Invitation: Board meeting').icons).toEqual([])
  expect((await open('Invitation: Board meeting')).attachments).toBeUndefined()

  expect(bySubject('Invite as a file').icons).toEqual(['paperclip'])
  const withFile = await open('Invite as a file')
  expect(withFile.attachments).toEqual([{ name: 'agenda.pdf', size: expect.any(String), index: 1 }])

  expect(bySubject('Calendar export').icons).toEqual(['paperclip'])
  expect((await open('Calendar export')).attachments?.map((a) => a.name)).toEqual(['Board meeting.ics'])
})

test('attachments cache by account, message and index for offline open and forwarding', async () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-attach-`)
  process.env.JEFI_CONFIG_DIR = dir
  cleanups.push(() => { delete process.env.JEFI_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }) })
  const opened: string[] = []
  const { engine, events, account } = await harness(
    {
      INBOX: [
        { raw: rawMessage({ n: 1, subject: 'Numbers', attachment: { filename: 'q3.csv', content: 'a,b\n1,2' } }) },
        { raw: rawMessage({ n: 2, subject: 'Sneaky', attachment: { filename: '../../evil.sh', content: 'rm -rf ~' } }) },
        {
          raw: rawMessage({
            n: 3,
            subject: 'Duplicates',
            attachments: [
              { filename: 'report.txt', content: 'first report' },
              { filename: 'report.txt', content: 'second report' },
            ],
          }),
        },
      ],
    },
    { openFile: (path) => opened.push(path) },
  )
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  const byName = async (subject: string) => {
    const listed = lastSnapshot(events)!.upserts.find((t) => t.subject === subject)!
    return (await engine.loadThread(account.id, listed.id))!.messages[0]!
  }

  const numbers = await byName('Numbers')
  const fetched = await engine.getAttachment(account.id, numbers.id, 0)
  expect(fetched.ok).toBe(true)
  if (!fetched.ok) throw new Error(fetched.error)
  expect(readFileSync(fetched.path, 'utf8')).toBe('a,b\n1,2')
  expect(fetched.path.startsWith(`${dir}/attachments/`)).toBe(true)
  expect(opened).toEqual([])

  // Opened while online, so its body (and so its attachment list) is known whether or not backfill
  // got to it first: offline, an uncached attachment is then a clear "You're offline".
  const sneakyMessage = await byName('Sneaky')
  engine.setOffline(true)
  expect(await engine.getAttachment(account.id, numbers.id, 0)).toEqual(fetched)
  expect(await engine.openAttachment(account.id, numbers.id, 0)).toEqual({ ok: true })
  expect(opened).toEqual([fetched.path])
  expect(await engine.getAttachment(account.id, sneakyMessage.id, 0)).toEqual({ ok: false, error: "You're offline" })

  engine.setOffline(false)
  const sneaky = await engine.getAttachment(account.id, sneakyMessage.id, 0)
  expect(sneaky.ok).toBe(true)
  if (!sneaky.ok) throw new Error(sneaky.error)
  expect(sneaky.path.slice(`${dir}/attachments/`.length)).not.toContain('..')

  const duplicates = await byName('Duplicates')
  const first = await engine.getAttachment(account.id, duplicates.id, 0)
  const second = await engine.getAttachment(account.id, duplicates.id, 1)
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  if (!first.ok || !second.ok) throw new Error('Duplicate attachments were not downloaded')
  expect(first.path).not.toBe(second.path)
  expect(first.path.endsWith('/0/report.txt')).toBe(true)
  expect(second.path.endsWith('/1/report.txt')).toBe(true)
  expect(readFileSync(first.path, 'utf8')).toBe('first report')
  expect(readFileSync(second.path, 'utf8')).toBe('second report')

  expect(await engine.getAttachment(account.id, numbers.id, 5)).toEqual({ ok: false, error: 'Attachment not found' })
  expect(await engine.getAttachment('another-account', numbers.id, 0)).toEqual({ ok: false, error: 'Attachment not found' })
  expect(await engine.getAttachment(account.id, `another-account:t1-${numbers.id.split('-').at(-1)}`, 0)).toEqual({ ok: false, error: 'Attachment not found' })

  writeFileSync(fetched.path, 'x')
  engine.setOffline(true)
  expect(await engine.getAttachment(account.id, numbers.id, 0)).toEqual({ ok: false, error: "You're offline" })

  await engine.forgetAccount(account.id)
  expect(existsSync(fetched.path)).toBe(false)
})

test('original message export caches exact source and enforces account/message ownership', async () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-original-`)
  process.env.JEFI_CONFIG_DIR = dir
  cleanups.push(() => { delete process.env.JEFI_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }) })
  const raw = rawMessage({
    n: 81,
    subject: 'Exact source',
    text: 'Line one.\r\nLine two.',
    extraHeaders: ['List-Unsubscribe: <mailto:leave@example.com?subject=unsubscribe>, <https://example.com/unsubscribe/81>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'],
  })
  const { engine, events, account } = await harness({ INBOX: [{ raw }] })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  const listed = lastSnapshot(events)!.upserts[0]!
  const opened = await engine.loadThread(account.id, listed.id)
  const id = opened!.messages[0]!.id
  expect(opened!.messages[0]!.unsubscribe).toEqual({
    oneClick: 'https://example.com/unsubscribe/81',
    link: 'https://example.com/unsubscribe/81',
    mailto: 'mailto:leave@example.com?subject=unsubscribe',
  })

  const fetched = await engine.getOriginalMessage(account.id, id)
  expect(fetched.ok).toBe(true)
  if (!fetched.ok) throw new Error(fetched.error)
  expect(readFileSync(fetched.path)).toEqual(Buffer.from(raw))
  expect(fetched.size).toBe(Buffer.byteLength(raw))
  expect(fetched.path.startsWith(`${dir}/originals/`)).toBe(true)

  engine.setOffline(true)
  expect(await engine.getOriginalMessage(account.id, id)).toEqual(fetched)
  expect(await engine.getOriginalMessage('another-account', id)).toEqual({ ok: false, error: 'Message source not found' })
  expect(await engine.getOriginalMessage(account.id, `another-account:t1-${id.split('-').at(-1)}`)).toEqual({ ok: false, error: 'Message source not found' })

  await engine.forgetAccount(account.id)
  expect(existsSync(fetched.path)).toBe(false)
})

test('a denied Keychain read is treated as a sign-in problem without exposing its raw error', async () => {
  const db = openDatabase(':memory:')
  const engine = createImapEngine({
    database: () => db,
    secrets: { get: async () => { throw new Error('securityd internal detail') }, set: async () => {}, delete: async () => {} },
    wake: false,
    watch: false,
  })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => engine.dispose())
  cleanups.push(() => db.close())
  const account = { id: 'denied', name: 'Me', email: 'me@example.com', provider: 'imap' as const, face: { letter: 'M' }, servers: { imapHost: '127.0.0.1', imapPort: 143, imapSecurity: 'none' as const, smtpHost: '127.0.0.1', smtpPort: 25, smtpSecurity: 'none' as const } }
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  const connection = events.filter((event): event is Extract<EngineEvent, { type: 'connection' }> => event.type === 'connection').at(-1)
  expect(connection).toMatchObject({ status: 'error', needsSignIn: true })
  expect(connection?.error).not.toContain('securityd internal detail')
})

test('a rejected or missing sign-in is flagged as needing sign-in; a dead server is not', async () => {
  const lastConnection = (events: EngineEvent[]) => events.filter((e): e is Extract<EngineEvent, { type: 'connection' }> => e.type === 'connection').at(-1)

  const wrong = await harness({ INBOX: [] }, { secret: 'not-the-password' })
  wrong.engine.setAccounts([wrong.account])
  wrong.engine.syncNow(wrong.account.id, true)
  await waitForSync(wrong.events)
  expect(lastConnection(wrong.events)).toMatchObject({ status: 'error', needsSignIn: true })

  const missing = await harness({ INBOX: [] }, { secret: null })
  missing.engine.setAccounts([missing.account])
  missing.engine.syncNow(missing.account.id, true)
  await waitForSync(missing.events)
  expect(lastConnection(missing.events)).toMatchObject({ status: 'error', needsSignIn: true })

  const down = await harness({ INBOX: [] })
  await down.server.close()
  down.engine.setAccounts([down.account])
  down.engine.syncNow(down.account.id, true)
  await waitForSync(down.events)
  expect(lastConnection(down.events)).toMatchObject({ status: 'error', needsSignIn: false })
})

test('a big first sync streams the list, newest mail first, before it finishes', async () => {
  const N = 1500
  const { engine, events, account } = await harness({
    INBOX: Array.from({ length: N }, (_, i) => ({ raw: rawMessage({ n: i + 1, subject: `Message ${i + 1}`, date: new Date(Date.UTC(2025, 0, 1) + i * 60_000) }) })),
  })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  const done = await waitForSync(events, 0, 60_000)
  const doneAt = events.indexOf(done)
  const early = events.slice(0, doneAt).filter((e): e is Extract<EngineEvent, { type: 'threadsChanged' }> => e.type === 'threadsChanged' && !!e.replaceAll)
  expect(early.length).toBeGreaterThan(0)
  // The first list shown already has the newest message, not the oldest.
  expect(early[0]!.upserts.some((t) => t.subject === `Message ${N}`)).toBe(true)
}, 90_000)

test('a change only the screener can see is published, though the list fingerprint is unchanged', async () => {
  // Dated now, so switching the Screener on counts this sender as someone new.
  const { engine, events, account } = await harness({ INBOX: [{ raw: rawMessage({ n: 1, subject: 'Newsletter', date: new Date() }) }] })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  expect(lastSnapshot(events)!.upserts.map((t) => t.screened)).toEqual([undefined])

  // Screening moves nothing: every count the fingerprint sums stays the same, and the list must
  // still be published or the conversation never leaves the Inbox on screen.
  const mark = events.length
  await engine.setScreener(account.id, true)
  const started = Date.now()
  while (Date.now() - started < 5_000 && !lastSnapshot(events.slice(mark))) await Bun.sleep(20)
  expect(lastSnapshot(events.slice(mark))!.upserts.map((t) => t.screened)).toEqual([true])
})

test('a body the server never sends says so, instead of loading forever', async () => {
  const { engine, events, account, server } = await harness({
    INBOX: [{ raw: rawMessage({ n: 1, subject: 'Old news', text: 'The full story, only on the server.' }) }],
  }, { bodyLimit: 0 })
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  await waitForSync(events)
  const listed = lastSnapshot(events)!.upserts[0]!

  // The server goes away before the reader can fetch the body.
  await server.pause()
  const opened = await engine.loadThread(account.id, listed.id)
  const message = opened!.messages[0]!
  // Not "still downloading": the reader would show a skeleton for ever.
  expect(message.bodyMissing).toBeUndefined()
  expect(message.paragraphs.at(-1)).toContain("Couldn't download the rest of this message")
  await server.resume()
})

test('mail moved back to the Inbox here is not announced as new, while real arrivals still are', async () => {
  const { server, engine, events, account } = await harness({
    INBOX: [{ raw: rawMessage({ n: 1, subject: 'Keep me' }) }, { raw: rawMessage({ n: 2, subject: 'Old news' }) }],
    Archive: { 'special-use': '\\Archive', messages: [] },
  })
  engine.setAccounts([account])
  engine.syncNow(account.id, false)
  await waitForSync(events)
  const old = lastSnapshot(events)!.upserts.find((t) => t.subject === 'Old news')!

  engine.move(account.id, old.id, 'archive')
  let mark = events.length
  engine.syncNow(account.id, false)
  await waitForSync(events, mark)

  // Undo: back to the Inbox, where the server gives it a new UID; a real message arrives alongside.
  const archived = lastSnapshot(events)!.upserts.find((t) => t.subject === 'Old news') ?? old
  engine.move(account.id, archived.id, 'inbox')
  server.append('INBOX', { raw: rawMessage({ n: 3, subject: 'Fresh news' }) })
  mark = events.length
  engine.syncNow(account.id, false)
  await waitForSync(events, mark)
  const incoming = events.slice(mark).filter((e) => e.type === 'threadsChanged' && e.incoming) as Array<Extract<EngineEvent, { type: 'threadsChanged' }>>
  expect(incoming.flatMap((e) => e.upserts.map((t) => t.subject))).toEqual(['Fresh news'])
  expect(lastSnapshot(events)!.upserts.find((t) => t.subject === 'Old news')?.folder).toBe('inbox')
  engine.dispose()
})
