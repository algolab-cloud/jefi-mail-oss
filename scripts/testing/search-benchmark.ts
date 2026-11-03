/**
 * Search benchmark (lume-ap4) on a synthetic in-memory mailbox, no network.
 *   bun scripts/testing/search-benchmark.ts [message-count]
 * One Inbox (default 50k messages, five to a conversation), median of 5 warm runs. Reports the key
 * query and the thread hydration the engine's search runs after it, for a spread of queries.
 */
import { openDatabase } from '../../src/engine/db'
import { searchThreadKeys } from '../../src/engine/search'
import { seedAccount, seedMailbox } from '../../src/engine/testing/seed'
import { loadThreads } from '../../src/engine/threads'

const COUNT = Number(process.argv[2] ?? 50_000)

const db = openDatabase(':memory:')
const account = seedAccount('bench')
const who = { account: { name: account.name, email: account.email } }
seedMailbox(db, account.id, account.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 1, subject: 'Inbox' })
const inbox = (db.query("SELECT id FROM mailboxes WHERE path = 'INBOX'").get() as { id: number }).id
const now = Date.now()
const WORDS = ['invoice', 'lunch', 'report', 'meeting', 'travel', 'budget', 'launch', 'review', 'party', 'contract']
db.transaction(() => {
  db.run(
    `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO messages (account_id, message_id, thread_id, subject, from_name, from_email, date, snippet, seen, has_attachments)
     SELECT ?, '<m' || i || '@example.com>', 't' || (i / 5), 'Note ' || i || ' ' || json_extract(?, '$[' || (i % 10) || ']'),
            CASE i % 4 WHEN 0 THEN 'Ada Lovelace' ELSE 'Bob Builder' END, CASE i % 4 WHEN 0 THEN 'ada@example.com' ELSE 'bob@example.com' END,
            ? - i * 60000, 'Body', i % 3 > 0, i % 7 = 0 FROM n`,
    [COUNT, account.id, JSON.stringify(WORDS), now],
  )
  db.run("INSERT INTO message_mailboxes (mailbox_id, uid, message_id) SELECT ?, id, id FROM messages WHERE account_id = ? AND message_id <> '<INBOX-1@example.com>'", [inbox, account.id])
})()
loadThreads(db, account.id, { limit: 1 })

const median = (run: () => unknown) => {
  run()
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    run()
    times.push(performance.now() - started)
  }
  return times.sort((a, b) => a - b)[2]!
}

const QUERIES = ['invoice', 'note 4242', 'from:ada', 'from:ada invoice is:unread', 'in:inbox budget', 'has:attachment', 'zzzz-nothing']
console.log(`${COUNT} messages in one Inbox, five to a conversation, median of 5 warm runs`)
console.log(`${'query'.padEnd(30)} ${'keys'.padStart(6)} ${'keys ms'.padStart(9)} ${'hydrate ms'.padStart(11)}`)
for (const query of QUERIES) {
  const keys = searchThreadKeys(db, account.id, query)
  const keysMs = median(() => searchThreadKeys(db, account.id, query))
  const hydrateMs = keys.length ? median(() => loadThreads(db, account.id, { ...who, threadKeys: keys })) : 0
  console.log(`${query.padEnd(30)} ${String(keys.length).padStart(6)} ${keysMs.toFixed(1).padStart(9)} ${hydrateMs.toFixed(1).padStart(11)}`)
}
db.close()
