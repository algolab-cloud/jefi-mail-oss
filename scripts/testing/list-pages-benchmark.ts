/**
 * List paging and snapshot benchmark (lume-2vz) on a synthetic in-memory mailbox, no network.
 *   bun scripts/testing/list-pages-benchmark.ts [message-count]
 * One Inbox of single-message conversations (default 50k), median of 3 warm runs. Reports the
 * keyset pages next to what the old grow-the-limit query and fingerprint scans cost on the same data.
 */
import { openDatabase } from '../../src/engine/db'
import { seedAccount, seedMailbox } from '../../src/engine/testing/seed'
import { hasOlderThreads, listRevision, loadThreads, loadView, type ViewCursor } from '../../src/engine/threads'

const COUNT = Number(process.argv[2] ?? 50_000)
const PAGE = 200
const WINDOW = 500

const db = openDatabase(':memory:')
const account = seedAccount('bench')
const who = { account: { name: account.name, email: account.email } }
// One seeded row, then the rest copied in SQL: seeding row by row would dominate the run.
seedMailbox(db, account.id, account.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 1, subject: 'Inbox' })
const inbox = (db.query("SELECT id FROM mailboxes WHERE path = 'INBOX'").get() as { id: number }).id
const now = Date.now()
db.transaction(() => {
  db.run(
    `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO messages (account_id, message_id, subject, from_name, from_email, date, snippet, seen)
     SELECT ?, '<m' || i || '@example.com>', 'Inbox ' || i, 'Ada Lovelace', 'ada@example.com', ? - i * 60000, 'Body', i % 3 > 0 FROM n`,
    [COUNT, account.id, now],
  )
  db.run("INSERT INTO message_mailboxes (mailbox_id, uid, message_id) SELECT ?, id, id FROM messages WHERE account_id = ? AND message_id <> '<INBOX-1@example.com>'", [inbox, account.id])
})()
// Threading the mailbox once is first-sync work, not something a page pays for.
loadThreads(db, account.id, { limit: 1 })

const median = (run: () => unknown) => {
  run()
  const times: number[] = []
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    run()
    times.push(performance.now() - started)
  }
  return times.sort((a, b) => a - b)[1]!
}
const mib = (value: unknown) => (JSON.stringify(value ?? null).length / 1024 / 1024).toFixed(2)
const rows: Array<[string, number, string]> = []
const measure = (label: string, run: () => unknown) => {
  const ms = median(run)
  rows.push([label, ms, mib(run())])
}

measure('page 1 (200)', () => loadView(db, account.id, 'inbox', { ...who, limit: PAGE }))
// The cursor 24 pages down, found by walking there like someone scrolling.
let cursor: ViewCursor | null = null
for (let n = 0; n < 24; n++) cursor = loadView(db, account.id, 'inbox', { ...who, limit: PAGE, after: cursor })!.nextCursor
measure('page 25 (keyset, rows 4800-5000)', () => loadView(db, account.id, 'inbox', { ...who, limit: PAGE, after: cursor }))
measure('page 25 the old way (limit 5000)', () => loadView(db, account.id, 'inbox', { ...who, limit: 25 * PAGE }))

// A publish while scrolled 5k deep: the fresh first page plus what changed since the pages loaded.
const since = listRevision(db, account.id).rev
db.run("UPDATE messages SET flagged = 1 WHERE id = (SELECT id FROM messages WHERE subject = 'Inbox 4900')")
measure('view refresh at 5k deep (head + 1 change)', () => loadView(db, account.id, 'inbox', { ...who, limit: PAGE, since }))

const oldFingerprint = () => {
  db.query('SELECT count(*) c, max(id) i, sum(seen) s, sum(flagged) f, max(date) d FROM messages WHERE account_id = ?').get(account.id)
  db.query('SELECT count(*) c FROM message_mailboxes mm JOIN messages m ON m.id = mm.message_id WHERE m.account_id = ?').get(account.id)
  db.query('SELECT count(*) c, max(updated_at) u FROM drafts WHERE account_id = ?').get(account.id)
  db.query('SELECT count(*) c FROM bodies b JOIN messages m ON m.id = b.message_id WHERE m.account_id = ?').get(account.id)
}
const build = () => ({ threads: loadThreads(db, account.id, { ...who, limit: WINDOW }), more: hasOlderThreads(db, account.id, WINDOW) })
measure('old fingerprint scan', oldFingerprint)
measure('list revision', () => listRevision(db, account.id))
measure('publish, list changed (revision + window 500 + hasOlder)', () => (listRevision(db, account.id), build()))
measure('publish, unchanged (revision, cached window)', () => listRevision(db, account.id))
measure('old publish (fingerprint + window 500 + hasOlder)', () => (oldFingerprint(), build()))

console.log(`${COUNT} single-message conversations in one Inbox, median of 3 warm runs`)
for (const [label, ms, size] of rows) console.log(`${label.padEnd(58)} ${ms.toFixed(1).padStart(8)} ms ${size.padStart(7)} MiB`)
db.close()
