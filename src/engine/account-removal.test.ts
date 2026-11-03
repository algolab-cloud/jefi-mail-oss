import { expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from './db'
import { deleteAccountData, storedAccountIds } from './mail-store'

/**
 * One row in every table for this account: mail, search, local state, queues and settings. Plus an
 * event (in the one shared calendar), a note link and a task link that point at its mail: those outlive it.
 */
function fill(db: MailDatabase, id: string) {
  db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 1)', [id, `${id}@example.com`])
  db.run("INSERT INTO mailboxes (account_id, path, special_use) VALUES (?, 'INBOX', '\\Inbox')", [id])
  const box = (db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  db.run("INSERT INTO messages (account_id, subject, from_email, date) VALUES (?, 'Hello', 'ada@example.com', 1)", [id])
  const message = (db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  // The insert also fills the message's search row and conversations summary (triggers).
  db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, 1, ?)', [box, message])
  db.run('INSERT INTO mailbox_aliases (mailbox_id, uid, message_id) VALUES (?, 2, ?)', [box, message])
  db.run("INSERT INTO bodies (message_id, text, fetched_at) VALUES (?, 'searchable words', 1)", [message])
  db.run("INSERT INTO attachments (message_id, filename) VALUES (?, 'a.pdf')", [message])
  db.run("INSERT INTO message_labels (message_id, label) VALUES (?, 'Work')", [message])
  db.run("INSERT INTO local_labels (id, account_id, name) VALUES (?, ?, 'Work')", [`lb:${id}:w`, id])
  db.run("INSERT INTO local_label_links (label_id, account_id, message_key) VALUES (?, ?, '<hello@example.com>')", [`lb:${id}:w`, id])
  db.run("INSERT INTO pending_ops (account_id, kind, payload_json, created_at) VALUES (?, 'flags', '{}', 1)", [id])
  db.run("INSERT INTO outbound_queue (id, account_id, mail_json, state, created_at, updated_at) VALUES (?, ?, '{}', 'queued', 1, 1)", [`out-${id}`, id])
  db.run("INSERT INTO drafts (id, account_id, mail_json, updated_at) VALUES (?, ?, '{}', 1)", [`draft-${id}`, id])
  db.run("INSERT INTO draft_removals (account_id, message_id) VALUES (?, '<gone@example.com>')", [id])
  db.run("INSERT INTO rules (id, account_id, rule_json) VALUES (?, ?, '{}')", [`rule-${id}`, id])
  db.run('INSERT INTO screener (account_id, enabled_at) VALUES (?, 1)', [id])
  db.run("INSERT INTO sender_verdicts (account_id, email, verdict) VALUES (?, 'spam@example.com', 'block')", [id])
  db.run("INSERT INTO snoozes (account_id, thread_id, until) VALUES (?, 't1', 1)", [id])
  db.run("INSERT INTO list_removals (account_id, rev, key) VALUES (?, 1, 'm0')", [id])
  db.run("INSERT INTO invites (message_id, idx, method, ics) VALUES (?, 0, 'REQUEST', 'BEGIN:VCALENDAR')", [message])
  db.run("INSERT INTO invite_state (message_id, state, processed_at) VALUES (?, 'applied', 1)", [message])
  db.run("INSERT INTO events (id, calendar_id, uid, account_id, title, start_at, end_at, created_at, updated_at) VALUES (?, 'local', ?, ?, 'Meet', 1, 2, 1, 1)", [`evt-${id}`, `uid-${id}`, id])
  const link = (table: string, owner: string) =>
    db.run(`INSERT INTO ${table} VALUES (?, ?, 'message', ${table === 'event_links' ? "'invite', " : ''}?, ?, '<m@example.com>', '{"subject":"Hello"}', 1)`, [`${table}-${id}`, owner, id, `${id}:m${message}-${message}`])
  link('event_links', `evt-${id}`)
  link('note_links', 'note')
  link('task_links', 'task')
}

/** Tables of what belongs to no account: removing one keeps every row. */
const SHARED = ['calendars', 'events', 'event_links', 'notes', 'note_search', 'note_links', 'reminders_fired', 'tasks', 'task_search', 'task_links', 'task_projects', 'task_labels', 'task_label_links', 'task_numbers']

/** Row count of every table except SQLite's own, the search index's shadow tables and the deferred-conversation scratch tables (empty outside a transaction). */
const counts = (db: MailDatabase) =>
  Object.fromEntries(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search_%' AND name NOT LIKE 'note_search_%' AND name NOT LIKE 'task_search_%' AND name NOT IN ('conversation_defer', 'conversation_dirty')").all() as Array<{ name: string }>).map(
      ({ name }) => [name, (db.query(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n],
    ),
  )

for (const foreignKeys of [true, false]) {
  test(`removing an account deletes its rows from every table, search included (foreign_keys ${foreignKeys ? 'on' : 'off'})`, () => {
    const db = openDatabase(':memory:')
    if (!foreignKeys) db.exec('PRAGMA foreign_keys = OFF')
    db.run("INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('note', 'Notes', 'searchable too', 1, 1)")
    db.run("INSERT INTO tasks (id, uid, number, title, notes, created_at, updated_at) VALUES ('task', 'task@jefi', 1, 'Reply', 'searchable as well', 1, 1)")
    fill(db, 'gone')
    fill(db, 'kept')
    // Two of everything per account: a table this test doesn't fill (a new one) fails here until it does.
    const before = counts(db)
    for (const [table, n] of Object.entries(before)) expect([table, n]).toEqual([table, SHARED.includes(table) ? n : 2])
    expect(SHARED.map((t) => before[t])).toEqual([1, 2, 2, 1, 1, 2, 0, 1, 1, 2, 0, 0, 0, 1])
    expect(db.query("SELECT count(*) n FROM message_search WHERE message_search MATCH 'searchable'").get()).toEqual({ n: 2 })

    deleteAccountData(db, 'gone')

    for (const [table, n] of Object.entries(counts(db))) expect([table, n]).toEqual([table, SHARED.includes(table) ? before[table] : 1])
    // What pointed into the removed account keeps its snapshot and nothing else.
    for (const table of ['event_links', 'note_links', 'task_links']) {
      expect(db.query(`SELECT account_id, target_ref, message_id_header, snapshot_json FROM ${table} ORDER BY id`).all()).toEqual([
        { account_id: null, target_ref: null, message_id_header: null, snapshot_json: '{"subject":"Hello"}' },
        { account_id: 'kept', target_ref: expect.stringMatching(/^kept:m\d+-\d+$/), message_id_header: '<m@example.com>', snapshot_json: '{"subject":"Hello"}' },
      ])
    }
    expect(db.query('SELECT id, account_id FROM events ORDER BY id').all()).toEqual([
      { id: 'evt-gone', account_id: null },
      { id: 'evt-kept', account_id: 'kept' },
    ])
    expect(db.query("SELECT count(*) n FROM note_search WHERE note_search MATCH 'searchable'").get()).toEqual({ n: 1 })
    expect(db.query("SELECT count(*) n FROM task_search WHERE task_search MATCH 'searchable'").get()).toEqual({ n: 1 })
    expect(storedAccountIds(db)).toEqual(['kept'])
    const kept = db.query("SELECT id FROM messages WHERE account_id = 'kept'").get() as { id: number }
    expect(db.query("SELECT rowid FROM message_search WHERE message_search MATCH 'searchable'").all()).toEqual([{ rowid: kept.id }])
    expect(db.query('SELECT count(*) n FROM message_search').get()).toEqual({ n: 1 })
    db.close()
  })
}
