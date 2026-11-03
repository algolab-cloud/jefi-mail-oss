/**
 * Live crash-recovery scenarios (lume-n57) against one real account, through the real engine.
 *   bun scripts/testing/live-recovery.ts <account-id>
 *
 * Scenarios: offline changes survive a restart, a send killed mid-flight goes out exactly once,
 * and a folder deleted and recreated (new UIDVALIDITY) resyncs without stale or doubled mail.
 *
 * Safety rules (every one is enforced below; a failed check aborts the run, then cleans up):
 * - Reads ~/.config/jefi/accounts.json only. Everything written lives in a fresh /tmp/jefi-live-*
 *   config dir (JEFI_CONFIG_DIR) holding just the account under test and a new mail.db; the real
 *   mail.db and settings are never opened. The temp dir is deleted at the end.
 * - Keychain reads pass through; writes and deletes are dropped (a refreshed OAuth token lives in
 *   this process's memory only).
 * - Works only inside folders it creates: Jefi-Test-<YYYYMMDD-HHMMSS> and ...-B (labels on Gmail),
 *   filled only with messages it APPENDs itself ("[Jefi test] ..." subjects, Message-IDs under
 *   @jefi-test.invalid). Every engine action is checked first: each message of the conversation
 *   must be one of ours (and, off Gmail, stored only in a test folder), and each queued server op
 *   must touch only test folders, or the run aborts before going online.
 * - The only mail sent is one message from the account to its own address, subject
 *   "[Jefi test] outbox crash <ts>" (the cap is 2 per account; this sends 1).
 * - Cleanup runs in finally: our messages (matched by Message-ID) are removed from the test
 *   folders, Inbox, Sent and Trash, the test folders are deleted, and a LIST + SEARCH confirms
 *   nothing of ours is left.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImapFlow } from 'imapflow'
import type { Account } from '../../src/accounts'
import { createImapClient } from '../../src/engine/connection'
import { credentialsFor } from '../../src/engine/credentials'
import { openDatabase, type MailDatabase } from '../../src/engine/db'
import { createImapEngine } from '../../src/engine/imap-engine'
import { listMailboxes } from '../../src/engine/mail-store'
import { getOutgoing } from '../../src/engine/outbox'
import { gmailLabelId, pendingCount, type PendingOp } from '../../src/engine/pending-ops'
import { keychainSecrets, type SecretStore } from '../../src/engine/secrets'
import { threadMessageIds, uiThreadId } from '../../src/engine/threading'
import type { EngineEvent, MailEngine } from '../../src/engine/types'

const REAL_CONFIG = join(homedir(), '.config', 'jefi')
const DOMAIN = 'jefi-test.invalid'
const SEND_CAP = 2
// /tmp itself, not $TMPDIR: easy to spot and to check.
const TMP = '/tmp'

class SafetyError extends Error {}
const guard = (ok: unknown, what: string): asserts ok => {
  if (!ok) throw new SafetyError(`SAFETY: ${what}`)
}
const check = (ok: unknown, what: string): asserts ok => {
  if (!ok) throw new Error(`CHECK FAILED: ${what}`)
}

const log = (...parts: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...parts)
const bare = (id: string | null | undefined) => (id ?? '').trim().replace(/^<|>$/g, '')
const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const waitFor = async <T>(what: string, fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms: number, every = 250): Promise<T> => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const value = await fn()
    if (value) return value
    await Bun.sleep(every)
  }
  throw new Error(`timed out after ${ms}ms: ${what}`)
}

// --- Secrets: reads from the Keychain, writes kept in memory ------------------------------------

function memorySecrets(): SecretStore {
  const keychain = keychainSecrets()
  const kept = new Map<string, string>()
  return {
    get: async (id) => kept.get(id) ?? keychain.get(id),
    async set(id, value) {
      kept.set(id, value)
    },
    async delete(id) {
      log(`  [${id}] secret delete ignored (test run)`)
    },
  }
}

// --- Temp installation ------------------------------------------------------------------------

function loadAccount(id: string): Account {
  const file = JSON.parse(readFileSync(join(REAL_CONFIG, 'accounts.json'), 'utf8')) as { accounts: Account[] }
  const account = file.accounts.find((a) => a.id === id)
  guard(account, `account ${id} not found in accounts.json`)
  return account
}

function tempInstallation(account: Account, ts: string) {
  const dir = join(TMP, `jefi-live-${account.id}-${ts}`)
  guard(!dir.startsWith(REAL_CONFIG), 'temp dir resolved inside the real config dir')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ accounts: [account], activeId: account.id }, null, 2))
  process.env.JEFI_CONFIG_DIR = dir
  return { dir, dbPath: join(dir, 'mail.db') }
}

type Live = { engine: MailEngine; db: MailDatabase; events: EngineEvent[] }

function bootEngine(account: Account, dbPath: string, secrets: SecretStore, startOffline = false): Live {
  guard(dbPath.startsWith(`${TMP}/jefi-live-`) && !dbPath.startsWith(REAL_CONFIG), `database ${dbPath} is not in the temp dir`)
  const db = openDatabase(dbPath)
  const engine = createImapEngine({
    database: () => db,
    secrets,
    // Nothing runs on its own: no push, no body download, no timers worth mentioning.
    watch: false,
    wake: false,
    bodyLimit: 0,
    draftSyncDelayMs: 3_600_000,
    schedulerMs: 3_600_000,
  })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  if (startOffline) engine.setOffline(true)
  engine.setAccounts([account])
  return { engine, db, events }
}

const stopEngine = (live: Live | null) => {
  if (!live) return
  live.engine.dispose()
  live.db.close()
}

async function syncOnce(live: Live, accountId: string, ms = 20 * 60_000) {
  const mark = live.events.length
  const started = Date.now()
  live.engine.syncNow(accountId, true)
  const done = await waitFor(
    'sync to finish',
    () => live.events.slice(mark).find((e) => e.type === 'syncState' && (e.state.status === 'idle' || e.state.status === 'error')),
    ms,
  )
  if (done.type === 'syncState' && done.state.status === 'error') throw new Error(`sync failed: ${done.state.error}`)
  return Date.now() - started
}

// --- Raw IMAP (the harness's own view of the server) --------------------------------------------

async function rawClient(account: Account, secrets: SecretStore) {
  const client = createImapClient(account, await credentialsFor(secrets, account.id))
  client.on('error', () => {})
  await client.connect()
  return client
}

async function withRaw<T>(account: Account, secrets: SecretStore, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await rawClient(account, secrets)
  try {
    return await work(client)
  } finally {
    await client.logout().catch(() => client.close())
  }
}

async function special(client: ImapFlow) {
  const list = await client.list()
  const use = (u: string) => list.find((b) => b.specialUse === u)?.path ?? null
  return { list, inbox: 'INBOX', sent: use('\\Sent'), trash: use('\\Trash'), all: use('\\All') }
}

type Seen = { uid: number; messageId: string; flags: string[]; labels: string[]; subject: string }

/** Every message in a folder, with its Message-ID and the two flags the scenarios touch. */
async function folderContents(client: ImapFlow, path: string, gmail: boolean): Promise<Seen[]> {
  const lock = await client.getMailboxLock(path, { readOnly: true })
  try {
    if (!client.mailbox || client.mailbox.exists === 0) return []
    const out: Seen[] = []
    for await (const m of client.fetch('1:*', { uid: true, envelope: true, flags: true, ...(gmail ? { labels: true } : {}) })) {
      out.push({
        uid: m.uid,
        messageId: bare(m.envelope?.messageId),
        flags: [...(m.flags ?? [])].filter((f) => f === '\\Seen' || f === '\\Flagged').sort(),
        labels: [...(m.labels ?? [])].sort(),
        subject: m.envelope?.subject ?? '',
      })
    }
    return out
  } finally {
    lock.release()
  }
}

/** UIDs in `path` whose Message-ID is one of `ids`. Gmail searches by Message-ID; others by our subject tag, then filter. */
async function findOurs(client: ImapFlow, path: string, ids: Set<string>, gmail: boolean): Promise<Array<{ uid: number; messageId: string; subject: string }>> {
  const lock = await client.getMailboxLock(path, { readOnly: true })
  try {
    if (!client.mailbox || client.mailbox.exists === 0) return []
    let uids: number[] = []
    if (gmail) {
      for (const id of ids) uids.push(...((await client.search({ gmraw: `rfc822msgid:${id}` }, { uid: true })) || []))
    } else {
      uids = (await client.search({ subject: 'Jefi test' }, { uid: true })) || []
    }
    if (!uids.length) return []
    const out: Array<{ uid: number; messageId: string; subject: string }> = []
    for await (const m of client.fetch([...new Set(uids)].join(','), { uid: true, envelope: true }, { uid: true })) {
      const messageId = bare(m.envelope?.messageId)
      if (ids.has(messageId)) out.push({ uid: m.uid, messageId, subject: m.envelope?.subject ?? '' })
    }
    return out
  } finally {
    lock.release()
  }
}

async function countTagged(client: ImapFlow, path: string, gmail: boolean) {
  const lock = await client.getMailboxLock(path, { readOnly: true })
  try {
    if (!client.mailbox || client.mailbox.exists === 0) return 0
    const found = gmail ? await client.search({ gmraw: 'subject:"[Jefi test]"' }, { uid: true }) : await client.search({ subject: '[Jefi test]' }, { uid: true })
    return (found || []).length
  } finally {
    lock.release()
  }
}

/** Deletes only UIDs whose Message-ID was just confirmed to be ours, in that same folder. */
async function deleteOurs(client: ImapFlow, path: string, ids: Set<string>, gmail: boolean) {
  const ours = await findOurs(client, path, ids, gmail)
  if (!ours.length) return 0
  for (const m of ours) guard(ids.has(m.messageId) && m.subject.includes('[Jefi test]'), `refusing to delete ${path} uid ${m.uid}: not a harness message`)
  const lock = await client.getMailboxLock(path)
  try {
    await client.messageDelete(ours.map((m) => m.uid).join(','), { uid: true })
  } finally {
    lock.release()
  }
  return ours.length
}

/** Gmail: a message only goes for good from Trash. Move ours from All Mail to Trash, then delete there. */
async function purgeGmail(client: ImapFlow, all: string, trash: string, ids: Set<string>) {
  const ours = await findOurs(client, all, ids, true)
  for (const m of ours) guard(ids.has(m.messageId) && m.subject.includes('[Jefi test]'), `refusing to move ${all} uid ${m.uid}: not a harness message`)
  if (ours.length) {
    const lock = await client.getMailboxLock(all)
    try {
      await client.messageMove(ours.map((m) => m.uid).join(','), trash, { uid: true })
    } finally {
      lock.release()
    }
  }
  return { moved: ours.length, purged: await deleteOurs(client, trash, ids, true) }
}

// --- Messages the harness appends -------------------------------------------------------------

function rawMessage(account: Account, messageId: string, subject: string) {
  return Buffer.from(
    [
      `From: ${account.name} <${account.email}>`,
      `To: ${account.email}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${messageId}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is an automated Jefi recovery test (scripts/testing/live-recovery.ts).',
      'It lives only in a Jefi-Test-* folder the test created, and the test deletes it when it finishes.',
      'If you can still see it, it is safe to delete.',
      '',
    ].join('\r\n'),
  )
}

// --- The run ----------------------------------------------------------------------------------

type Result = { scenario: string; pass: boolean; ms: number; evidence: string[]; error?: string }

async function run(accountId: string) {
  const account = loadAccount(accountId)
  const gmail = account.provider === 'gmail'
  const ts = stamp()
  const folderA = `Jefi-Test-${ts}`
  const folderB = `Jefi-Test-${ts}-B`
  const inTest = (path: string) => path === folderA || path === folderB
  const { dir, dbPath } = tempInstallation(account, ts)
  const secrets = memorySecrets()
  const ours = new Set<string>()
  const newId = (tag: string) => {
    const id = `${tag}-${ts}-${Math.random().toString(36).slice(2, 8)}@${DOMAIN}`
    ours.add(id)
    return id
  }
  const results: Result[] = []
  const cleanupNotes: string[] = []
  let live: Live | null = null
  let sends = 0
  let foldersCreated = false
  let taggedBefore: number | null = null
  log(`account ${account.id} (${account.provider}, ${account.servers.imapHost}); temp dir ${dir}; folders ${folderA}, ${folderB}`)

  const threadOf = (db: MailDatabase, messageId: string) => {
    const row = db.query('SELECT id, thread_id FROM messages WHERE account_id = ? AND message_id IN (?, ?)').get(account.id, messageId, `<${messageId}>`) as { id: number; thread_id: string | null } | null
    return row ? uiThreadId(account.id, row.thread_id, row.id) : null
  }
  const storedCount = (db: MailDatabase, messageId: string) =>
    (db.query('SELECT count(*) n FROM messages WHERE account_id = ? AND message_id IN (?, ?)').get(account.id, messageId, `<${messageId}>`) as { n: number }).n

  /** Every engine action goes through this: the conversation must be ours, and live in a test folder. */
  const guardThread = (db: MailDatabase, threadId: string) => {
    const ids = threadMessageIds(db, account.id, threadId)
    guard(ids.length > 0, `thread ${threadId} has no messages`)
    for (const id of ids) {
      const row = db.query('SELECT message_id FROM messages WHERE id = ?').get(id) as { message_id: string | null }
      guard(ours.has(bare(row.message_id)), `thread ${threadId} holds message ${id} that the harness did not append`)
      const paths = (db.query('SELECT mb.path FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = ?').all(id) as Array<{ path: string }>).map((r) => r.path)
      if (gmail) {
        const labels = (db.query('SELECT label FROM message_labels WHERE message_id = ?').all(id) as Array<{ label: string }>).map((r) => r.label)
        guard(labels.some(inTest), `thread ${threadId}: message ${id} carries no test label (${labels.join(', ')})`)
      } else guard(paths.length > 0 && paths.every(inTest), `thread ${threadId}: message ${id} is in ${paths.join(', ')}`)
    }
    return ids
  }

  /** Before going online: every queued server op must be about our messages and test folders only. */
  const guardQueue = (db: MailDatabase, allMail: string | null) => {
    const rows = db.query('SELECT payload_json FROM pending_ops WHERE account_id = ?').all(account.id) as Array<{ payload_json: string }>
    for (const row of rows) {
      const op = JSON.parse(row.payload_json) as PendingOp
      const msg = db.query('SELECT message_id FROM messages WHERE id = ?').get(op.messageId) as { message_id: string | null } | null
      guard(msg && ours.has(bare(msg.message_id)), `queued ${op.kind} op for a message the harness did not append`)
      for (const l of op.locations) guard(inTest(l.path) || (gmail && l.path === allMail), `queued ${op.kind} op touches ${l.path}`)
      if (op.kind === 'move') guard(inTest(op.target.path), `queued move targets ${op.target.path}`)
      if (op.kind === 'labels') for (const l of [...op.add, ...op.remove]) guard(inTest(l), `queued label change touches ${l}`)
      guard(op.kind !== 'delete', 'a delete was queued')
    }
    return rows.length
  }

  try {
    // ---- Setup: two test folders, six messages -------------------------------------------------
    const setupStarted = Date.now()
    const initial = [
      { key: 'star', seen: false },
      { key: 'star-unstar', seen: false },
      { key: 'read', seen: false },
      { key: 'unread', seen: true },
      { key: 'move', seen: false },
      { key: 'control', seen: false },
    ].map((m) => ({ ...m, id: newId(m.key) }))
    const pre = await withRaw(account, secrets, async (client) => {
      const boxes = await special(client)
      guard(!boxes.list.some((b) => b.path.startsWith(folderA)), `${folderA} already exists`)
      const tagged = { inbox: await countTagged(client, 'INBOX', gmail) }
      await client.mailboxCreate(folderA)
      foldersCreated = true
      await client.mailboxCreate(folderB)
      for (const m of initial) await client.append(folderA, rawMessage(account, m.id, `[Jefi test] ${m.key} ${ts}`), m.seen ? ['\\Seen'] : [])
      const status = await client.status(folderA, { uidValidity: true, messages: true })
      return { boxes, tagged, status }
    })
    const allMail = pre.boxes.all
    taggedBefore = pre.tagged.inbox
    log(`setup: ${folderA} has ${pre.status.messages} messages, UIDVALIDITY ${pre.status.uidValidity}; "[Jefi test]" in INBOX before: ${pre.tagged.inbox}`)
    check(pre.status.messages === initial.length, `${folderA} should hold ${initial.length} messages`)

    live = bootEngine(account, dbPath, secrets)
    const firstSyncMs = await syncOnce(live, account.id)
    log(`first engine sync: ${firstSyncMs}ms, ${(live.db.query('SELECT count(*) n FROM messages').get() as { n: number }).n} messages stored`)
    for (const m of initial) check(storedCount(live.db, m.id) === 1, `engine stored ${m.key} once`)
    const setupMs = Date.now() - setupStarted

    // ---- 1. Offline changes, restart while offline ---------------------------------------------
    {
      const started = Date.now()
      const evidence: string[] = [`setup + first full engine sync: ${setupMs}ms (sync alone ${firstSyncMs}ms)`]
      try {
        const db = live.db
        const thread = Object.fromEntries(initial.map((m) => [m.key, threadOf(db, m.id)!])) as Record<string, string>
        for (const t of Object.values(thread)) guardThread(db, t)
        live.engine.setOffline(true)
        live.engine.setFlags(account.id, thread['star']!, { starred: true })
        live.engine.setFlags(account.id, thread['star-unstar']!, { starred: true })
        live.engine.setFlags(account.id, thread['star-unstar']!, { starred: false })
        live.engine.setFlags(account.id, thread['read']!, { unread: false })
        live.engine.setFlags(account.id, thread['unread']!, { unread: true })
        if (gmail) {
          // A Gmail "move" between labels is a label change on the conversation.
          live.engine.setLabels(account.id, thread['move']!, [gmailLabelId(account.id, folderB)])
        } else {
          // engine.move only targets special-use folders. To keep the move inside the test namespace,
          // the temp DB briefly calls folder B the Archive; the next sync's LIST puts it back.
          db.run("UPDATE mailboxes SET special_use = NULL WHERE account_id = ? AND special_use IN ('\\Archive', '\\All')", [account.id])
          db.run("UPDATE mailboxes SET special_use = '\\Archive' WHERE account_id = ? AND path = ?", [account.id, folderB])
          live.engine.move(account.id, thread['move']!, 'archive')
        }
        const queued = guardQueue(db, allMail)
        evidence.push(`queued offline: ${queued} ops (5 flag changes + 1 ${gmail ? 'label change' : 'move'}), all on harness messages in test folders`)

        // The restart: the engine goes away with its queue on disk, a new one opens the same file offline.
        stopEngine(live)
        live = null
        live = bootEngine(account, dbPath, secrets, true)
        const afterRestart = pendingCount(live.db, account.id)
        check(afterRestart === queued, `queue survived the restart (${afterRestart}/${queued})`)
        guardQueue(live.db, allMail)
        evidence.push(`after restart (still offline): ${afterRestart} ops on disk`)
        live.engine.setOffline(false)
        const replayMs = await syncOnce(live, account.id)
        check(pendingCount(live.db, account.id) === 0, 'queue drained')
        evidence.push(`online sync replayed the queue in ${replayMs}ms; pending ops now 0`)

        const server = await withRaw(account, secrets, async (client) => ({ a: await folderContents(client, folderA, gmail), b: await folderContents(client, folderB, gmail) }))
        const byId = (list: Seen[]) => new Map(list.map((m) => [m.messageId, m]))
        const a = byId(server.a)
        const b = byId(server.b)
        const expected: Record<string, { folder: 'a' | 'b'; flags: string[] }> = {
          star: { folder: 'a', flags: ['\\Flagged'] },
          'star-unstar': { folder: 'a', flags: [] },
          read: { folder: 'a', flags: ['\\Seen'] },
          unread: { folder: 'a', flags: [] },
          move: { folder: 'b', flags: [] },
          control: { folder: 'a', flags: [] },
        }
        check(server.a.every((m) => ours.has(m.messageId)) && server.b.every((m) => ours.has(m.messageId)), 'test folders hold only harness messages')
        check(server.a.length === 5 && server.b.length === 1, `folder counts A=${server.a.length} B=${server.b.length}, expected 5/1`)
        for (const m of initial) {
          const want = expected[m.key]!
          const got = (want.folder === 'a' ? a : b).get(m.id)
          const other = (want.folder === 'a' ? b : a).get(m.id)
          check(got && !other, `${m.key} is in folder ${want.folder.toUpperCase()} only`)
          check(got.flags.join() === want.flags.join(), `${m.key} flags ${got.flags.join('+') || 'none'}, expected ${want.flags.join('+') || 'none'}`)
          evidence.push(`server: ${m.key} in ${want.folder.toUpperCase()} flags [${got.flags.join(' ')}]${gmail ? ` labels [${got.labels.join(' ')}]` : ''}`)
        }
        results.push({ scenario: 'offline changes + restart', pass: true, ms: Date.now() - started, evidence })
      } catch (err) {
        if (err instanceof SafetyError) throw err
        results.push({ scenario: 'offline changes + restart', pass: false, ms: Date.now() - started, evidence, error: (err as Error).message })
      }
    }

    // ---- 3. UIDVALIDITY: folder deleted and recreated under the same name ----------------------
    {
      const started = Date.now()
      const evidence: string[] = []
      try {
        live ??= bootEngine(account, dbPath, secrets)
        const db = live.db
        const box = listMailboxes(db, account.id).find((b) => b.path === folderA)
        const oldValidity = gmail ? null : box?.uidvalidity
        if (!gmail) check(oldValidity != null, `engine has a UIDVALIDITY for ${folderA}`)
        const fresh = ['fresh-1', 'fresh-2', 'fresh-3'].map((key) => ({ key, id: newId(key) }))
        const before = await withRaw(account, secrets, async (client) => {
          const was = await client.status(folderA, { uidValidity: true, messages: true })
          await client.mailboxDelete(folderA)
          await client.mailboxCreate(folderA)
          for (const m of fresh) await client.append(folderA, rawMessage(account, m.id, `[Jefi test] ${m.key} ${ts}`), [])
          const now = await client.status(folderA, { uidValidity: true, messages: true })
          return { was, now }
        })
        evidence.push(`server ${folderA}: UIDVALIDITY ${before.was.uidValidity} -> ${before.now.uidValidity}, messages ${before.was.messages} -> ${before.now.messages}`)
        check(String(before.was.uidValidity) !== String(before.now.uidValidity), 'server reports a new UIDVALIDITY')
        const syncMs = await syncOnce(live, account.id)
        evidence.push(`engine resync: ${syncMs}ms`)
        for (const m of fresh) check(storedCount(db, m.id) === 1, `${m.key} stored exactly once`)
        const oldKeys = initial.filter((m) => m.key !== 'move')
        if (gmail) {
          // Gmail labels are views of All Mail: the old messages keep their All Mail UID, lose the label.
          const labelled = (db.query('SELECT m.message_id FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.account_id = ? AND ml.label = ?').all(account.id, folderA) as Array<{ message_id: string }>).map((r) => bare(r.message_id))
          check(labelled.length === 3 && fresh.every((m) => labelled.includes(m.id)), `label ${folderA} holds exactly the 3 fresh messages locally (has ${labelled.length})`)
          for (const m of oldKeys) check(storedCount(db, m.id) === 1, `${m.key} still stored once (in All Mail)`)
          evidence.push(`local: label ${folderA} = 3 fresh messages; 5 old ones stored once each, no longer labelled`)
        } else {
          const after = listMailboxes(db, account.id).find((b) => b.path === folderA)!
          check(String(after.uidvalidity) === String(before.now.uidValidity), `engine took the new UIDVALIDITY (${after.uidvalidity})`)
          const links = db.query('SELECT mm.uid, m.message_id FROM message_mailboxes mm JOIN messages m ON m.id = mm.message_id WHERE mm.mailbox_id = ?').all(after.id) as Array<{ uid: number; message_id: string }>
          check(links.length === 3 && fresh.every((m) => links.some((l) => bare(l.message_id) === m.id)), `${folderA} links exactly the 3 fresh messages (has ${links.length})`)
          for (const m of oldKeys) check(storedCount(db, m.id) === 0, `${m.key} (deleted with the old folder) is gone locally`)
          evidence.push(`local: UIDVALIDITY ${oldValidity} -> ${after.uidvalidity}; ${folderA} links ${links.length} (UIDs ${links.map((l) => l.uid).join(',')}); 5 stale messages removed`)
        }
        const dupes = db.query('SELECT message_id, count(*) n FROM messages WHERE account_id = ? AND message_id LIKE ? GROUP BY message_id HAVING n > 1').all(account.id, `%@${DOMAIN}%`) as unknown[]
        check(dupes.length === 0, `no duplicate harness messages locally (${dupes.length})`)
        evidence.push('no duplicate Message-IDs among harness messages in the DB')
        results.push({ scenario: 'UIDVALIDITY reset', pass: true, ms: Date.now() - started, evidence })
      } catch (err) {
        if (err instanceof SafetyError) throw err
        results.push({ scenario: 'UIDVALIDITY reset', pass: false, ms: Date.now() - started, evidence, error: (err as Error).message })
      }
    }

    // ---- 2. Outbox: process killed mid-send ----------------------------------------------------
    {
      const started = Date.now()
      const evidence: string[] = []
      const subject = `[Jefi test] outbox crash ${ts}`
      const sendThread = `jefi-test-send-${ts}`
      try {
        stopEngine(live)
        live = null
        guard(sends < SEND_CAP, 'send cap reached')
        sends++
        // A real kill: a child process runs the engine and is SIGKILLed the moment the send starts.
        const child = Bun.spawn(['bun', import.meta.path, '--send-child', account.id, dbPath, sendThread, subject], {
          env: { ...process.env, JEFI_CONFIG_DIR: dir },
          stdout: 'pipe',
          stderr: 'inherit',
        })
        let messageId = ''
        let killedAt = 0
        const decoder = new TextDecoder()
        let buffered = ''
        for await (const chunk of child.stdout) {
          buffered += decoder.decode(chunk)
          const q = buffered.match(/QUEUED (\S+)/)
          if (q) messageId = bare(q[1])
          if (buffered.includes('SENDING')) {
            child.kill(9)
            killedAt = Date.now()
            break
          }
          if (buffered.includes('SENT')) break
        }
        await child.exited
        check(killedAt, `child was killed mid-send (output: ${buffered.trim()})`)
        check(messageId.endsWith('>') || messageId.includes('@'), `child reported its Message-ID (${messageId})`)
        ours.add(messageId)
        evidence.push(`child engine queued ${messageId}, SIGKILLed ${killedAt - started}ms after spawn, as soon as it reported "sending" (exit ${child.exitCode ?? child.signalCode})`)

        const peek = openDatabase(dbPath)
        const crashed = getOutgoing(peek, sendThread)
        peek.close()
        evidence.push(`on disk after the kill: outbox state '${crashed?.state}' (a fresh open recovers 'sending' to 'queued')`)
        const early = await withRaw(account, secrets, async (client) => (await findOurs(client, 'INBOX', new Set([messageId]), gmail)).length)
        evidence.push(`Inbox copies right after the kill: ${early}`)

        const restartAt = Date.now()
        live = bootEngine(account, dbPath, secrets)
        const db = live.db
        check(getOutgoing(db, sendThread)?.messageId && bare(getOutgoing(db, sendThread)!.messageId) === messageId, 'restart kept the original Message-ID')
        const sentState = await waitFor('outbox to deliver', () => getOutgoing(db, sendThread)?.state === 'sent' || getOutgoing(db, sendThread)?.state === 'failed' ? getOutgoing(db, sendThread)!.state : null, 120_000)
        check(sentState === 'sent', `outbox reached 'sent' (${sentState}: ${getOutgoing(db, sendThread)?.lastError ?? ''})`)
        evidence.push(`restart delivered in ${Date.now() - restartAt}ms (outbox 'sent')`)
        stopEngine(live)
        live = null

        const ids = new Set([messageId])
        const count = () =>
          withRaw(account, secrets, async (client) => {
            const boxes = await special(client)
            const inbox = (await findOurs(client, 'INBOX', ids, gmail)).length
            const sent = boxes.sent ? (await findOurs(client, boxes.sent, ids, gmail)).length : -1
            const all = gmail && boxes.all ? (await findOurs(client, boxes.all, ids, gmail)).length : null
            return { inbox, sent, all }
          })
        const arrived = await waitFor('the message in Inbox and Sent', async () => {
          const c = await count()
          return c.inbox >= 1 && c.sent >= 1 ? c : null
        }, 180_000, 5000)
        // Late duplicates would show up a little after the first copy; look again.
        await Bun.sleep(45_000)
        const settled = await count()
        evidence.push(`by Message-ID: Inbox ${arrived.inbox} -> ${settled.inbox}, Sent ${arrived.sent} -> ${settled.sent}${gmail ? `, All Mail ${settled.all}` : ''} (rechecked after 45s)`)
        if (gmail) evidence.push('caveat: Gmail drops a second message with a Message-ID it already has, so on Gmail one copy is necessary but not proof of one delivery')
        check(settled.inbox === 1, `exactly one Inbox copy (${settled.inbox})`)
        check(settled.sent === 1, `exactly one Sent copy (${settled.sent})`)
        results.push({ scenario: 'outbox killed mid-send', pass: true, ms: Date.now() - started, evidence })
      } catch (err) {
        if (err instanceof SafetyError) throw err
        results.push({ scenario: 'outbox killed mid-send', pass: false, ms: Date.now() - started, evidence, error: (err as Error).message })
      }
    }
  } catch (err) {
    log(`ABORTED: ${(err as Error).message}`)
    results.push({ scenario: 'run', pass: false, ms: 0, evidence: [], error: (err as Error).message })
  } finally {
    stopEngine(live)
    live = null
    // ---- Cleanup ---------------------------------------------------------------------------------
    try {
      await withRaw(account, secrets, async (client) => {
        const boxes = await special(client)
        if (gmail) {
          guard(boxes.all && boxes.trash, 'Gmail All Mail / Trash not found')
          const r = await purgeGmail(client, boxes.all, boxes.trash, ours)
          cleanupNotes.push(`moved ${r.moved} harness messages All Mail -> Trash, deleted ${r.purged} from Trash`)
        } else {
          for (const path of [folderA, folderB, 'INBOX', boxes.sent].filter((p): p is string => !!p)) {
            if (!boxes.list.some((b) => b.path === path)) continue
            const n = await deleteOurs(client, path, ours, false)
            if (n) cleanupNotes.push(`deleted ${n} harness messages from ${path}`)
          }
        }
        if (foldersCreated) {
          for (const path of [folderB, folderA]) {
            if ((await client.list()).some((b) => b.path === path)) {
              await client.mailboxDelete(path)
              cleanupNotes.push(`deleted folder ${path}`)
            }
          }
        }
        // Some servers park deleted mail (or folders) in Trash: sweep ours out of there too.
        const after = await special(client)
        if (after.trash) {
          const n = await deleteOurs(client, after.trash, ours, gmail)
          if (n) cleanupNotes.push(`deleted ${n} harness messages from ${after.trash}`)
        }
        const leftFolders = after.list.filter((b) => b.path.includes(`Jefi-Test-${ts}`)).map((b) => b.path)
        const left: string[] = []
        for (const path of [after.inbox, after.sent, after.trash, after.all].filter((p): p is string => !!p)) {
          const n = (await findOurs(client, path, ours, gmail)).length
          if (n) left.push(`${path}: ${n}`)
        }
        const tagged = await countTagged(client, 'INBOX', gmail)
        cleanupNotes.push(`verify: folders left matching Jefi-Test-${ts}: ${leftFolders.length ? leftFolders.join(', ') : 'none'}`)
        cleanupNotes.push(`verify: harness Message-IDs left in Inbox/Sent/Trash${gmail ? '/All Mail' : ''}: ${left.length ? left.join('; ') : 'none'} (${ours.size} ids checked)`)
        cleanupNotes.push(`verify: "[Jefi test]" subjects in INBOX: ${tagged} (before the run: ${taggedBefore ?? 'not counted'})`)
      })
    } catch (err) {
      cleanupNotes.push(`CLEANUP ERROR: ${(err as Error).message}`)
    }
    rmSync(dir, { recursive: true, force: true })
    cleanupNotes.push(`removed temp dir ${dir}`)
  }

  console.log(JSON.stringify({ account: account.id, provider: account.provider, host: account.servers.imapHost, ts, results, cleanup: cleanupNotes, sends }, null, 2))
  return results.every((r) => r.pass)
}

/** The process that gets killed: queue one self-addressed send and report when SMTP starts. */
async function sendChild(accountId: string, dbPath: string, threadId: string, subject: string) {
  const account = loadAccount(accountId)
  guard(process.env.JEFI_CONFIG_DIR && dbPath.startsWith(process.env.JEFI_CONFIG_DIR), 'child database outside its temp dir')
  guard(subject.startsWith('[Jefi test] outbox crash '), 'unexpected subject')
  const live = bootEngine(account, dbPath, memorySecrets())
  live.engine.subscribe((events) => {
    for (const e of events) {
      if (e.type !== 'outboxState' || e.threadId !== threadId) continue
      if (e.state === 'sending') console.log('SENDING')
      if (e.state === 'sent') console.log('SENT')
      if (e.state === 'failed') console.log(`FAILED ${e.error}`)
    }
  })
  live.engine.send(account.id, threadId, {
    to: [account.email],
    cc: [],
    bcc: [],
    subject,
    body: 'Automated Jefi recovery test: this message was sent by the account to itself while the sending process was killed. The test deletes it when it finishes.',
  })
  console.log(`QUEUED ${getOutgoing(live.db, threadId)?.messageId}`)
  await Bun.sleep(120_000)
  process.exit(3)
}

const args = process.argv.slice(2)
if (args[0] === '--send-child') await sendChild(args[1]!, args[2]!, args[3]!, args[4]!)
else {
  if (!args[0]) {
    console.error('usage: bun scripts/testing/live-recovery.ts <account-id>')
    process.exit(2)
  }
  process.exit((await run(args[0])) ? 0 : 1)
}
