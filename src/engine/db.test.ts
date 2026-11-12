import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { MIGRATIONS, migrate, openDatabase, rebuildSearchIndex } from './db'

const version = (db: ReturnType<typeof openDatabase>) => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version

describe('mail database', () => {
  test('fresh database gets every migration', () => {
    const db = openDatabase(':memory:')
    expect(version(db)).toBe(MIGRATIONS.length)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['accounts', 'mailboxes', 'messages', 'message_mailboxes', 'bodies', 'attachments', 'pending_ops', 'outbound_queue', 'drafts']),
    )
  })

  test('reopening is idempotent and keeps data', () => {
    const dir = mkdtempSync(`${tmpdir()}/jefi-db-`)
    try {
      const path = `${dir}/mail.db`
      const first = openDatabase(path)
      first.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)', ['a1', 'a@example.com', 1])
      first.close()
      const second = openDatabase(path)
      expect(version(second)).toBe(MIGRATIONS.length)
      expect(second.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 1 })
      expect(migrate(second)).toBe(MIGRATIONS.length)
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })


  test('a failing migration rolls back and leaves the version untouched', () => {
    const db = openDatabase(':memory:')
    expect(() => migrate(db, [...MIGRATIONS, 'CREATE TABLE later (id INTEGER); THIS IS NOT SQL'])).toThrow()
    expect(version(db)).toBe(MIGRATIONS.length)
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'later'").get()).toBeNull()
  })

  test('migration 19 adds event alarms (existing events follow the default) and the fired-reminder log', () => {
    const db = openDatabase(':memory:')
    db.exec('DROP TABLE reminders_fired')
    db.exec('ALTER TABLE events DROP COLUMN alarms_json')
    db.exec('PRAGMA user_version = 18')
    db.run("INSERT INTO events (id, calendar_id, uid, title, start_at, end_at, created_at, updated_at) VALUES ('e1', 'local', 'u1', 'Old', 1, 2, 0, 0)")
    expect(migrate(db, MIGRATIONS.slice(0, 19))).toBe(19)
    expect(db.query('SELECT alarms_json FROM events').get()).toEqual({ alarms_json: null })
    db.run('INSERT INTO reminders_fired (event_id, occurrence_start, fire_at, fired_at) VALUES (?, ?, ?, ?)', ['e1', 1, 0, 5])
    // One row per event, occurrence and alert time: the claim that keeps a reminder from firing twice.
    expect(db.run('INSERT OR IGNORE INTO reminders_fired (event_id, occurrence_start, fire_at, fired_at) VALUES (?, ?, ?, ?)', ['e1', 1, 0, 6]).changes).toBe(0)
  })

  test('migration 20 adds tasks, their search index and their links', () => {
    const db = openDatabase(':memory:')
    for (const table of ['task_label_links', 'task_labels', 'task_links', 'task_search', 'tasks', 'task_projects']) db.exec(`DROP TABLE ${table}`)
    db.exec('PRAGMA user_version = 19')
    expect(migrate(db, MIGRATIONS.slice(0, 20))).toBe(20)
    db.run("INSERT INTO tasks (id, uid, title, notes, created_at, updated_at) VALUES ('t1', 'u1@jefi', 'Send the deck', 'slides', 1, 1)")
    expect(db.query("SELECT status, due_all_day, priority, origin FROM tasks WHERE id = 't1'").get()).toEqual({ status: 'open', due_all_day: 0, priority: 0, origin: 'manual' })
    expect(db.query("SELECT rowid FROM task_search WHERE task_search MATCH 'slides'").all()).toHaveLength(1)
    expect(() => db.run("UPDATE tasks SET status = 'maybe' WHERE id = 't1'")).toThrow()
    // Deleting a task drops its search row (trigger) and its links (cascade).
    db.run("INSERT INTO task_links (id, task_id, kind, created_at) VALUES ('l1', 't1', 'contact', 1)")
    db.run("DELETE FROM tasks WHERE id = 't1'")
    expect(db.query('SELECT count(*) n FROM task_search').get()).toEqual({ n: 0 })
    expect(db.query('SELECT count(*) n FROM task_links').get()).toEqual({ n: 0 })
  })

  test('migration 21 rebuilds tasks with statuses, priorities and numbers, keeping rows, links and search', () => {
    const db = openDatabase(':memory:')
    for (const table of ['task_label_links', 'task_labels', 'task_links', 'task_search', 'tasks', 'task_projects']) db.exec(`DROP TABLE ${table}`)
    db.exec('ALTER TABLE outbound_queue DROP COLUMN body_sent_at') // added by migration 27, which runs again
    db.exec('ALTER TABLE messages DROP COLUMN sign_in') // added by migration 28, which runs again
    db.exec('DROP INDEX pending_ops_message') // made by migration 29, which runs again
    db.exec('ALTER TABLE pending_ops DROP COLUMN message_id')
    db.exec('PRAGMA user_version = 19')
    migrate(db, MIGRATIONS.slice(0, 20))
    db.run("INSERT INTO tasks (id, uid, title, notes, status, priority, created_at, updated_at) VALUES ('a', 'ua', 'First', 'slides', 'open', 1, 1, 1), ('b', 'ub', 'Second', '', 'done', 0, 2, 2)")
    db.run("INSERT INTO task_links (id, task_id, kind, created_at) VALUES ('l1', 'a', 'contact', 1)")
    expect(migrate(db)).toBe(MIGRATIONS.length)
    // Open becomes todo, a flag becomes high, and numbers follow creation.
    expect(db.query('SELECT id, number, status, priority FROM tasks ORDER BY number').all()).toEqual([
      { id: 'a', number: 1, status: 'todo', priority: 2 },
      { id: 'b', number: 2, status: 'done', priority: 0 },
    ])
    expect(db.query("SELECT rowid FROM task_search WHERE task_search MATCH 'slides'").all()).toEqual([{ rowid: 1 }])
    expect(() => db.run("UPDATE tasks SET status = 'open' WHERE id = 'a'")).toThrow()
    // The links survived and still cascade; search rows still follow deletes.
    expect(db.query('SELECT count(*) n FROM task_links').get()).toEqual({ n: 1 })
    db.run("DELETE FROM tasks WHERE id = 'a'")
    expect(db.query('SELECT count(*) n FROM task_links').get()).toEqual({ n: 0 })
    expect(db.query('SELECT count(*) n FROM task_search').get()).toEqual({ n: 1 })
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('migration 22 adds task reminders, following the default until one is chosen', () => {
    const db = openDatabase(':memory:')
    db.exec('ALTER TABLE tasks DROP COLUMN alarms_json')
    db.exec('ALTER TABLE outbound_queue DROP COLUMN body_sent_at') // added by migration 27, which runs again
    db.exec('ALTER TABLE messages DROP COLUMN sign_in') // added by migration 28, which runs again
    db.exec('DROP INDEX pending_ops_message') // made by migration 29, which runs again
    db.exec('ALTER TABLE pending_ops DROP COLUMN message_id')
    db.exec('PRAGMA user_version = 21')
    db.run("INSERT INTO tasks (id, uid, number, title, created_at, updated_at) VALUES ('t', 'u', 1, 'Old', 1, 1)")
    expect(migrate(db)).toBe(MIGRATIONS.length)
    expect(db.query("SELECT alarms_json FROM tasks WHERE id = 't'").get()).toEqual({ alarms_json: null })
  })

  test('migration 23 drops bodies whose QP text lost its high bytes, so backfill fetches them again', () => {
    const db = openDatabase(':memory:')
    db.exec('ALTER TABLE outbound_queue DROP COLUMN body_sent_at') // added by migration 27, which runs again
    db.exec('ALTER TABLE messages DROP COLUMN sign_in') // added by migration 28, which runs again
    db.exec('DROP INDEX pending_ops_message') // made by migration 29, which runs again
    db.exec('ALTER TABLE pending_ops DROP COLUMN message_id')
    db.exec('PRAGMA user_version = 22')
    db.run("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'me@example.com', 1)")
    const message = (subject: string) => Number(db.run("INSERT INTO messages (account_id, subject, date) VALUES ('a', ?, 1)", [subject]).lastInsertRowid)
    const broken = message('Broken')
    const fine = message('Fine')
    const body = db.prepare('INSERT INTO bodies (message_id, text, html, fetched_at) VALUES (?, ?, ?, 1)')
    body.run(broken, 'You\u0019ve got mail', '<p>You’ve got mail</p>')
    body.run(fine, 'You’ve got mail', null)
    expect(migrate(db)).toBe(MIGRATIONS.length)
    expect(db.query('SELECT message_id FROM bodies').all()).toEqual([{ message_id: fine }])
  })

  test('migration 24 starts the task counter at the highest task number', () => {
    const db = openDatabase(':memory:')
    db.exec('DROP TABLE task_numbers')
    db.exec('ALTER TABLE outbound_queue DROP COLUMN body_sent_at') // added by migration 27, which runs again
    db.exec('ALTER TABLE messages DROP COLUMN sign_in') // added by migration 28, which runs again
    db.exec('DROP INDEX pending_ops_message') // made by migration 29, which runs again
    db.exec('ALTER TABLE pending_ops DROP COLUMN message_id')
    db.exec('PRAGMA user_version = 23')
    db.run("INSERT INTO tasks (id, uid, number, title, created_at, updated_at) VALUES ('a', 'ua', 4, 'A', 1, 1), ('b', 'ub', 7, 'B', 1, 1)")
    expect(migrate(db)).toBe(MIGRATIONS.length)
    expect(db.query('SELECT id, last FROM task_numbers').all()).toEqual([{ id: 1, last: 7 }])
  })

  test('migration 27 adds body_sent_at to the outbox, empty for rows already there', () => {
    const db = openDatabase(':memory:')
    db.exec('ALTER TABLE outbound_queue DROP COLUMN body_sent_at')
    db.exec('ALTER TABLE messages DROP COLUMN sign_in') // added by migration 28, which runs again
    db.exec('DROP INDEX pending_ops_message') // made by migration 29, which runs again
    db.exec('ALTER TABLE pending_ops DROP COLUMN message_id')
    db.exec('PRAGMA user_version = 26')
    db.run("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'me@example.com', 1)")
    db.run("INSERT INTO outbound_queue (id, account_id, mail_json, state, created_at, updated_at) VALUES ('o', 'a', '{}', 'failed', 1, 1)")
    expect(migrate(db)).toBe(MIGRATIONS.length)
    expect(db.query("SELECT body_sent_at FROM outbound_queue WHERE id = 'o'").get()).toEqual({ body_sent_at: null })
  })

  test('migration 28 adds sign_in to messages, empty for mail already stored', () => {
    const db = openDatabase(':memory:')
    db.exec('ALTER TABLE messages DROP COLUMN sign_in')
    db.exec('DROP INDEX pending_ops_message') // made by migration 29, which runs again
    db.exec('ALTER TABLE pending_ops DROP COLUMN message_id')
    db.exec('PRAGMA user_version = 27')
    expect(migrate(db)).toBe(MIGRATIONS.length)
    expect(db.query("SELECT name FROM pragma_table_info('messages') WHERE name = 'sign_in'").get()).toEqual({ name: 'sign_in' })
  })

  test('migration 29 indexes queued changes by message, for rows already queued and rows inserted without it', () => {
    const db = openDatabase(':memory:')
    db.exec('DROP INDEX pending_ops_message')
    db.exec('ALTER TABLE pending_ops DROP COLUMN message_id')
    db.exec('PRAGMA user_version = 28')
    db.run("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'me@example.com', 1)")
    db.run(`INSERT INTO pending_ops (account_id, kind, payload_json, created_at) VALUES ('a', 'move', '{"kind":"move","messageId":42,"locations":[]}', 1)`)
    expect(migrate(db)).toBe(MIGRATIONS.length)
    // As an older build would insert it: no message_id given.
    db.run(`INSERT INTO pending_ops (account_id, kind, payload_json, created_at) VALUES ('a', 'delete', '{"kind":"delete","messageId":7,"locations":[]}', 2)`)
    expect(db.query('SELECT kind, message_id FROM pending_ops ORDER BY id').all()).toEqual([
      { kind: 'move', message_id: 42 },
      { kind: 'delete', message_id: 7 },
    ])
    const plan = db.query("EXPLAIN QUERY PLAN SELECT id FROM pending_ops WHERE account_id = 'a' AND message_id = 7").all() as Array<{ detail: string }>
    expect(plan.map((p) => p.detail).join()).toContain('pending_ops_message')
  })

  test('one Gmail message in several labels is stored once', () => {
    const db = openDatabase(':memory:')
    db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)', ['g', 'me@gmail.com', 1])
    const box = (path: string, special: string | null) =>
      Number(db.run('INSERT INTO mailboxes (account_id, path, special_use, uidvalidity) VALUES (?, ?, ?, 1)', ['g', path, special]).lastInsertRowid)
    const inbox = box('INBOX', '\\Inbox')
    const work = box('Work', null)
    const all = box('[Gmail]/All Mail', '\\All')

    const upsert = db.prepare(
      `INSERT INTO messages (account_id, gm_msgid, subject, date) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, gm_msgid) WHERE gm_msgid IS NOT NULL DO UPDATE SET subject = excluded.subject
       RETURNING id`,
    )
    const link = db.prepare('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, ?, ?)')
    for (const [mailbox, uid] of [[inbox, 10], [work, 3], [all, 900]] as const) {
      const { id } = upsert.get('g', '1780000000000000001', 'Quarterly plan', 1) as { id: number }
      link.run(mailbox, uid, id)
    }

    expect(db.query('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 })
    expect(db.query('SELECT count(*) AS n FROM message_mailboxes').get()).toEqual({ n: 3 })
    // The same message can't be linked twice into one mailbox under different UIDs.
    const { id } = db.query('SELECT id FROM messages').get() as { id: number }
    expect(() => link.run(work, 4, id)).toThrow()
  })

  test('deleting an account cascades to its mail', () => {
    const db = openDatabase(':memory:')
    db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)', ['x', 'x@example.com', 1])
    const mailbox = Number(db.run("INSERT INTO mailboxes (account_id, path) VALUES ('x', 'INBOX')").lastInsertRowid)
    const message = Number(db.run("INSERT INTO messages (account_id, subject, date) VALUES ('x', 'hi', 1)").lastInsertRowid)
    db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, 1, ?)', [mailbox, message])
    db.run("INSERT INTO bodies (message_id, text, fetched_at) VALUES (?, 'body', 1)", [message])
    db.run("INSERT INTO outbound_queue (id, account_id, mail_json, state, created_at, updated_at) VALUES ('o', 'x', '{}', 'queued', 1, 1)")
    db.run("DELETE FROM accounts WHERE id = 'x'")
    for (const table of ['mailboxes', 'messages', 'message_mailboxes', 'bodies', 'outbound_queue']) {
      expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  })

  test('outbound_queue rejects unknown states', () => {
    const db = openDatabase(':memory:')
    db.run("INSERT INTO accounts (id, email, created_at) VALUES ('y', 'y@example.com', 1)")
    expect(() =>
      db.run("INSERT INTO outbound_queue (id, account_id, mail_json, state, created_at, updated_at) VALUES ('o', 'y', '{}', 'delivered', 1, 1)"),
    ).toThrow()
  })
})

describe('search index', () => {
  const hits = (db: ReturnType<typeof openDatabase>, q: string) =>
    (db.query('SELECT rowid FROM message_search WHERE message_search MATCH ? ORDER BY rowid').all(q) as { rowid: number }[]).map((r) => r.rowid)
  const seeded = () => {
    const db = openDatabase(':memory:')
    db.run("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'me@example.com', 1)")
    db.run("INSERT INTO messages (id, account_id, subject, from_name, from_email, to_json, date) VALUES (1, 'a', 'Invoice', 'Ada', 'ada@example.com', '[\"me@example.com\"]', 1)")
    db.run("INSERT INTO bodies (message_id, text, fetched_at) VALUES (1, 'quarterly numbers', 1)")
    return db
  }

  test('follows inserts, header edits, body changes and deletes', () => {
    const db = seeded()
    expect(hits(db, 'invoice')).toEqual([1])
    expect(hits(db, 'quarterly')).toEqual([1])

    db.run("UPDATE messages SET subject = 'Receipt', from_name = 'Grace' WHERE id = 1")
    expect(hits(db, 'invoice')).toEqual([])
    expect(hits(db, 'receipt')).toEqual([1])
    expect(hits(db, 'sender:grace')).toEqual([1])

    db.run("UPDATE bodies SET text = 'annual numbers' WHERE message_id = 1")
    expect(hits(db, 'quarterly')).toEqual([])
    db.run('DELETE FROM bodies WHERE message_id = 1')
    expect(hits(db, 'annual')).toEqual([])

    // Flag changes are the common update; they must leave the index alone.
    db.run('UPDATE messages SET seen = 1 WHERE id = 1')
    expect(hits(db, 'receipt')).toEqual([1])

    db.run('DELETE FROM messages WHERE id = 1')
    expect(hits(db, 'receipt')).toEqual([])
  })

  test('rebuilds from the tables', () => {
    const db = seeded()
    db.exec('DELETE FROM message_search')
    expect(hits(db, 'invoice')).toEqual([])
    expect(rebuildSearchIndex(db)).toBe(1)
    expect(hits(db, 'invoice')).toEqual([1])
    expect(hits(db, 'quarterly')).toEqual([1])
  })
})
