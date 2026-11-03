import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { MIGRATIONS, deferConversations, forwardCompatProblem, migrate, openDatabase, type MailDatabase } from './db'
import { deleteAccountData, ensureAccount, saveMailboxes, storeBatch } from './mail-store'
import { assignThreads } from './threading'
import { FOLDER_RANK, loadView } from './threads'

// The conversations summary (migration 16) must always equal what grouping every message says.
// Each test changes the mail one way and compares the table with that grouping, done here in JS.

type Summary = { account_id: string; key: string; thread_id: string | null; message_id: number | null; latest: number; place: string | null }

function expected(db: MailDatabase): Summary[] {
  const hidden = new Set(
    (db.query('SELECT account_id || char(0) || remote_message_id AS k FROM drafts WHERE remote_message_id IS NOT NULL UNION SELECT account_id || char(0) || message_id FROM draft_removals').all() as Array<{ k: string }>).map((r) => r.k),
  )
  const messages = db.query('SELECT id, account_id, thread_id, message_id, date FROM messages').all() as Array<{ id: number; account_id: string; thread_id: string | null; message_id: string | null; date: number }>
  const uses = db.query('SELECT mm.message_id AS id, mb.special_use AS use FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id').all() as Array<{ id: number; use: string | null }>
  const byKey = new Map<string, Summary & { rank: number }>()
  for (const m of messages) {
    if (m.message_id !== null && hidden.has(`${m.account_id}\u0000${m.message_id}`)) continue
    const key = m.thread_id ?? `m${m.id}`
    const id = `${m.account_id}\u0000${key}`
    const row = byKey.get(id) ?? { account_id: m.account_id, key, thread_id: m.thread_id, message_id: m.thread_id ? null : m.id, latest: m.date, place: null, rank: Infinity }
    row.latest = Math.max(row.latest, m.date)
    for (const u of uses) {
      const rank = FOLDER_RANK.findIndex(([use]) => use === u.use)
      if (u.id === m.id && rank >= 0 && rank < row.rank) Object.assign(row, { rank, place: FOLDER_RANK[rank]![1] })
    }
    byKey.set(id, row)
  }
  return [...byKey.values()].map(({ rank: _rank, ...row }) => row).sort((a, b) => `${a.account_id}${a.key}`.localeCompare(`${b.account_id}${b.key}`))
}

const stored = (db: MailDatabase) =>
  (db.query('SELECT account_id, key, thread_id, message_id, latest, place FROM conversations').all() as Summary[]).sort((a, b) => `${a.account_id}${a.key}`.localeCompare(`${b.account_id}${b.key}`))

function setup() {
  const db = openDatabase(':memory:')
  for (const id of ['a', 'b']) {
    db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 1)', [id, `${id}@example.com`])
    for (const [path, use] of [['INBOX', '\\Inbox'], ['Sent', '\\Sent'], ['Archive', '\\Archive'], ['All', '\\All'], ['Trash', '\\Trash'], ['Projects', null]]) {
      db.run('INSERT INTO mailboxes (account_id, path, special_use) VALUES (?, ?, ?)', [id, path, use])
    }
  }
  const box = (account: string, path: string) => (db.query('SELECT id FROM mailboxes WHERE account_id = ? AND path = ?').get(account, path) as { id: number }).id
  let uid = 0
  const add = (account: string, n: number, path: string, headers: { inReplyTo?: string; date?: number } = {}) => {
    db.run('INSERT INTO messages (account_id, message_id, in_reply_to, subject, date) VALUES (?, ?, ?, ?, ?)', [account, `<${account}${n}@x>`, headers.inReplyTo ?? null, `S${n}`, headers.date ?? n * 1000])
    const id = (db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
    db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, ?, ?)', [box(account, path), ++uid, id])
    return id
  }
  const check = () => expect(stored(db)).toEqual(expected(db))
  return { db, box, add, check }
}

test('new mail, replies and threading keep one summary per conversation', () => {
  const { db, add, check } = setup()
  add('a', 1, 'INBOX')
  add('a', 2, 'Sent', { inReplyTo: '<a1@x>' })
  add('b', 1, 'Projects')
  check()
  assignThreads(db, 'a')
  assignThreads(db, 'b')
  check()
  expect(stored(db).filter((c) => c.account_id === 'a')).toHaveLength(1)
  // A message that links two threads merges them.
  add('a', 3, 'Trash')
  add('a', 5, 'INBOX', { inReplyTo: '<a4@x>' })
  assignThreads(db, 'a')
  add('a', 4, 'Archive', { inReplyTo: '<a3@x>' })
  assignThreads(db, 'a')
  check()
  // Re-threading by hand: a message split back out.
  db.run("UPDATE messages SET thread_id = 'split' WHERE account_id = 'a' AND message_id = '<a2@x>'")
  check()
})

test('moves, copies, deletes and date changes follow the mailboxes', () => {
  const { db, box, add, check } = setup()
  const one = add('a', 1, 'INBOX')
  add('a', 2, 'Sent', { inReplyTo: '<a1@x>' })
  assignThreads(db, 'a')
  // Move the inbox copy to Trash: the conversation is now shown in Sent.
  db.run('UPDATE message_mailboxes SET mailbox_id = ? WHERE message_id = ?', [box('a', 'Trash'), one])
  check()
  expect(stored(db)[0]!.place).toBe('sent')
  db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, 99, ?)', [box('a', 'All'), one])
  check()
  db.run('DELETE FROM message_mailboxes WHERE message_id = ? AND mailbox_id = ?', [one, box('a', 'Trash')])
  db.run('UPDATE messages SET date = 50000 WHERE id = ?', [one])
  check()
  expect(stored(db)[0]!.latest).toBe(50000)
  db.run('DELETE FROM messages WHERE id = ?', [one])
  check()
  db.run("DELETE FROM messages WHERE account_id = 'a'")
  check()
  expect(stored(db)).toEqual([])
})

test("a mailbox's role changing or the mailbox going re-places its conversations", () => {
  const { db, box, add, check } = setup()
  add('a', 1, 'Projects')
  add('a', 2, 'Archive')
  check()
  db.run("UPDATE mailboxes SET special_use = '\\Junk' WHERE id = ?", [box('a', 'Projects')])
  check()
  expect(stored(db).map((c) => c.place).sort()).toEqual(['archive', 'spam'])
  db.run('DELETE FROM mailboxes WHERE id = ?', [box('a', 'Archive')])
  check()
})

test("flags and labels don't touch the summary, but still narrow their views", () => {
  const { db, add, check } = setup()
  const one = add('a', 1, 'INBOX')
  add('a', 2, 'INBOX')
  db.run('UPDATE messages SET flagged = 1, seen = 1 WHERE id = ?', [one])
  db.run("INSERT INTO message_labels (message_id, label) VALUES (?, 'Work')", [one])
  check()
  expect(loadView(db, 'a', 'starred')!.threads.map((t) => t.subject)).toEqual(['S1'])
  expect(loadView(db, 'a', 'inbox')!.threads.map((t) => t.subject)).toEqual(['S2', 'S1'])
  db.run('UPDATE messages SET flagged = 0 WHERE id = ?', [one])
  db.run('DELETE FROM message_labels WHERE message_id = ?', [one])
  check()
  expect(loadView(db, 'a', 'starred')!.threads).toEqual([])
})

test("Jefi's own drafts hide their server copies from the summary", () => {
  const { db, add, check } = setup()
  add('a', 1, 'INBOX')
  add('a', 2, 'INBOX')
  db.run("INSERT INTO drafts (id, account_id, mail_json, updated_at, remote_message_id) VALUES ('d', 'a', '{}', 1, '<a1@x>')")
  check()
  expect(stored(db).map((c) => c.key)).toHaveLength(1)
  db.run("UPDATE drafts SET remote_message_id = '<a2@x>' WHERE id = 'd'")
  check()
  db.run("DELETE FROM drafts WHERE id = 'd'")
  db.run("INSERT INTO draft_removals (account_id, message_id) VALUES ('a', '<a1@x>')")
  check()
  expect(stored(db)).toHaveLength(1)
  db.run('DELETE FROM draft_removals')
  check()
  expect(stored(db)).toHaveLength(2)
})

test("removing an account drops its summaries and leaves the other account's", () => {
  for (const foreignKeys of [true, false]) {
    const { db, add, check } = setup()
    if (!foreignKeys) db.exec('PRAGMA foreign_keys = OFF')
    add('a', 1, 'INBOX')
    add('a', 2, 'Sent', { inReplyTo: '<a1@x>' })
    add('b', 1, 'INBOX')
    assignThreads(db, 'a')
    deleteAccountData(db, 'a')
    check()
    expect(stored(db).map((c) => c.account_id)).toEqual(['b'])
  }
})

test('the migration fills the summary from mail stored before it', () => {
  const old = new Database(':memory:', { strict: true })
  migrate(old, MIGRATIONS.slice(0, 15))
  old.run("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'a@example.com', 1)")
  old.run("INSERT INTO mailboxes (account_id, path, special_use) VALUES ('a', 'INBOX', '\\Inbox'), ('a', 'Sent', '\\Sent')")
  old.run("INSERT INTO messages (account_id, message_id, thread_id, date) VALUES ('a', '<1@x>', 't1', 1), ('a', '<2@x>', 't1', 5), ('a', '<3@x>', NULL, 3)")
  old.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (2, 1, 1), (1, 2, 2), (2, 3, 3)')
  old.run("INSERT INTO drafts (id, account_id, mail_json, updated_at, remote_message_id) VALUES ('d', 'a', '{}', 1, '<2@x>')")
  migrate(old)
  expect(stored(old)).toEqual(expected(old))
  expect(stored(old)).toEqual([
    { account_id: 'a', key: 'm3', thread_id: null, message_id: 3, latest: 3, place: 'sent' },
    { account_id: 'a', key: 't1', thread_id: 't1', message_id: null, latest: 1, place: 'sent' },
  ])
})

// Deferred rebuilds (migration 24, lume-1t4): a burst of writes under deferConversations must leave
// exactly the table the row-by-row triggers do, whatever mix of writes it holds.
test('deferred rebuilds leave the same summaries as row-by-row triggers, over random bursts of writes', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const immediate = setup()
    const deferred = setup()
    let state = seed
    const rand = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state % n
    }
    const paths = ['INBOX', 'Sent', 'Archive', 'All', 'Trash', 'Projects']
    // The same random script, drawn once per step and replayed on both databases.
    const script: Array<(t: ReturnType<typeof setup>) => void> = []
    let n = 0
    for (let step = 0; step < 60; step++) {
      const kind = rand(10)
      const account = rand(4) === 0 ? 'b' : 'a'
      const a = rand(40) + 1
      const b = rand(40) + 1
      const path = paths[rand(paths.length)]!
      const other = paths[rand(paths.length)]!
      const date = rand(100) * 1000
      const reply = rand(2) === 0
      const thread = rand(3) === 0 ? null : `x${b % 3}`
      if (kind <= 2) {
        const at = ++n
        script.push((t) => t.add(account, at, path, { inReplyTo: reply ? `<${account}${a}@x>` : undefined, date }))
      } else if (kind === 3) script.push((t) => assignThreads(t.db, account))
      else if (kind === 4) script.push((t) => t.db.run('UPDATE message_mailboxes SET mailbox_id = ? WHERE message_id = ? AND message_id IN (SELECT id FROM messages WHERE account_id = ?)', [t.box(account, other), a, account]))
      else if (kind === 5) script.push((t) => t.db.run('DELETE FROM message_mailboxes WHERE message_id = ?', [a]))
      else if (kind === 6) script.push((t) => t.db.run('UPDATE messages SET date = ? WHERE id = ?', [date, a]))
      else if (kind === 7) script.push((t) => t.db.run('UPDATE messages SET thread_id = ? WHERE id = ?', [thread, a]))
      else if (kind === 8)
        script.push((t) =>
          t.db.run("INSERT INTO drafts (id, account_id, mail_json, updated_at, remote_message_id) VALUES ('d', ?, '{}', 1, ?) ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, remote_message_id = excluded.remote_message_id", [account, `<${account}${a}@x>`]),
        )
      else script.push((t) => t.db.run('DELETE FROM messages WHERE id = ?', [b]))
    }
    // Replay: immediate one step at a time; deferred in bursts of a few steps each.
    for (const step of script) step(immediate)
    for (let i = 0; i < script.length; ) {
      const burst = script.slice(i, i + 1 + (i % 7))
      deferConversations(deferred.db, () => burst.forEach((step) => step(deferred)))
      i += burst.length
    }
    expect(stored(deferred.db)).toEqual(stored(immediate.db))
    expect(stored(deferred.db)).toEqual(expected(deferred.db))
    expect(deferred.db.query('SELECT (SELECT count(*) FROM conversation_defer) + (SELECT count(*) FROM conversation_dirty) AS n').get()).toEqual({ n: 0 })
  }
}, 30_000)

test('a first sync through storeBatch and threading summarises exactly what the messages say', () => {
  const db = openDatabase(':memory:')
  ensureAccount(db, 'g', 'me@gmail.com')
  const [inbox, all] = saveMailboxes(db, 'g', [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }])
  const message = (i: number) => ({
    uid: i + 1, messageId: `<g${i}@x>`, gmMsgId: String(9000 + i), subject: i % 3 ? `Re: Topic ${i - 1}` : `Topic ${i}`, date: i * 60_000,
    inReplyTo: i % 3 ? `<g${i - 1}@x>` : null, references: i % 3 ? [`<g${i - 1}@x>`] : [], to: [], cc: [], bcc: [], replyTo: [], flags: [], labels: i % 2 ? ['Work'] : [],
  })
  for (const box of [all!, inbox!]) {
    for (let start = 0; start < 90; start += 25) {
      storeBatch(db, 'g', { id: box.id, uidvalidity: 1 }, Array.from({ length: Math.min(25, 90 - start) }, (_, k) => message(start + k)).filter((m) => box === all || m.uid % 4 === 0), { lastUid: start + 25 })
      assignThreads(db, 'g')
    }
  }
  expect(stored(db)).toEqual(expected(db))
  expect(stored(db)).toHaveLength(30)
  expect(new Set(stored(db).map((c) => c.place))).toEqual(new Set(['inbox', 'archive']))
})

test('a deferral that throws rolls back with its work and leaves the triggers immediate', () => {
  const { db, add, check } = setup()
  add('a', 1, 'INBOX')
  expect(() =>
    deferConversations(db, () => {
      add('a', 2, 'INBOX')
      throw new Error('boom')
    }),
  ).toThrow('boom')
  expect(db.query('SELECT count(*) AS n FROM conversation_defer').get()).toEqual({ n: 0 })
  expect(db.query('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 })
  add('a', 3, 'Sent')
  check()
  // Nested: only the outermost flushes, and everything is in place once it has.
  deferConversations(db, () => {
    add('a', 4, 'INBOX')
    deferConversations(db, () => add('a', 5, 'Archive'))
    expect(db.query('SELECT count(*) AS n FROM conversation_defer').get()).toEqual({ n: 1 })
  })
  check()
  expect(stored(db)).toHaveLength(4)
})

test('a build from before deferred rebuilds still opens the mailbox, and its writes keep summaries row by row', () => {
  const { db, add, check } = setup()
  expect(forwardCompatProblem(db, MIGRATIONS.slice(0, 24))).toBeNull()
  // What that build does: plain writes, never the deferral flag.
  add('a', 1, 'INBOX')
  add('a', 2, 'Sent', { inReplyTo: '<a1@x>' })
  check()
})

