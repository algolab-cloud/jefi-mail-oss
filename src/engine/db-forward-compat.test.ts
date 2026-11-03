import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { MIGRATIONS, openDatabase, openDatabaseReadOnly, type MailDatabase } from './db'
import { seedAccount, seedMailbox } from './testing/seed'
import { countInboxUnread } from './threads'

// ---------------------------------------------------------------------------
// A mail.db a newer Jefi migrated past this build: used as is when the change was additive, refused
// with a clear message when it took away something this build needs.
// ---------------------------------------------------------------------------

const OURS = MIGRATIONS.length
const NEWER = /upgraded by a newer Jefi in a way this version .* can't use .*; update Jefi/

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A file mail.db at this build's schema, then changed by `newer` and stamped one version on. */
function newerDb(newer: string, version = OURS + 1): string {
  const dir = mkdtempSync(`${tmpdir()}/jefi-compat-`)
  dirs.push(dir)
  const path = `${dir}/mail.db`
  const db = openDatabase(path)
  db.exec(newer)
  db.exec(`PRAGMA user_version = ${version}`)
  db.close()
  return path
}

const versionOf = (path: string) => {
  const db = new Database(path, { readonly: true })
  try {
    return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    db.close()
  }
}

/**
 * A newer schema without messages.snippet. The trigger that reads the column goes first, as a real
 * migration would have to: SQLite builds that check triggers on DROP COLUMN (Linux CI's) refuse it otherwise.
 */
const DROPPED_SNIPPET = 'DROP TRIGGER list_rev_message_update; ALTER TABLE messages DROP COLUMN snippet'

const ACCOUNT = seedAccount('acct')
const ADDITIVE = `
  CREATE TABLE later_things (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  ALTER TABLE messages ADD COLUMN later_note TEXT;
  ALTER TABLE mailboxes ADD COLUMN later_flag INTEGER NOT NULL DEFAULT 0;
`

function readWrite(db: MailDatabase) {
  const ids = seedMailbox(db, ACCOUNT.id, ACCOUNT.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 3, subject: 'Hello' })
  db.run(`UPDATE messages SET seen = 0 WHERE id IN (${ids.join(',')})`)
  expect(countInboxUnread(db, ACCOUNT)).toBe(3)
}

test('an additive newer schema opens unmigrated, reads and writes, and keeps its version', () => {
  const path = newerDb(ADDITIVE)
  const db = openDatabase(path)
  readWrite(db)
  db.close()
  expect(versionOf(path)).toBe(OURS + 1)
  // And again, now holding mail.
  const again = openDatabase(path)
  expect(again.query('SELECT count(*) n FROM messages').get()).toEqual({ n: 3 })
  again.close()
  expect(versionOf(path)).toBe(OURS + 1)
})

test('a newer schema that dropped or renamed a column this build needs is refused', () => {
  expect(() => openDatabase(newerDb(DROPPED_SNIPPET))).toThrow(NEWER)
  expect(() => openDatabase(newerDb('ALTER TABLE events RENAME COLUMN alarms_json TO alerts_json'))).toThrow(/events\.alarms_json is missing/)
  expect(() => openDatabase(newerDb('DROP TABLE reminders_fired'))).toThrow(/table reminders_fired is missing/)
})

test('a newer schema that lost a unique index upserts rely on is refused', () => {
  const path = newerDb(`
    CREATE TABLE r2 (event_id TEXT NOT NULL, occurrence_start INTEGER NOT NULL, fire_at INTEGER NOT NULL, fired_at INTEGER NOT NULL);
    DROP TABLE reminders_fired;
    ALTER TABLE r2 RENAME TO reminders_fired;
  `)
  expect(() => openDatabase(path)).toThrow(/reminders_fired lacks its unique/)
})

test('a newer schema whose added column this build could not fill is refused', () => {
  // A table rebuild, the only way SQLite adds a NOT NULL column without a default.
  const rebuilt = (extra: string) => `
    CREATE TABLE r2 (event_id TEXT NOT NULL, occurrence_start INTEGER NOT NULL, fire_at INTEGER NOT NULL,
      fired_at INTEGER NOT NULL, ${extra}, PRIMARY KEY (event_id, occurrence_start, fire_at)) WITHOUT ROWID;
    DROP TABLE reminders_fired;
    ALTER TABLE r2 RENAME TO reminders_fired;
  `
  expect(() => openDatabase(newerDb(rebuilt('channel TEXT NOT NULL'))).close()).toThrow(/new column reminders_fired\.channel is required/)
  expect(() => openDatabase(newerDb(rebuilt("channel TEXT NOT NULL DEFAULT 'banner'"))).close()).not.toThrow()
})

test('min_reader_version above this build is refused whatever the structure', () => {
  const path = newerDb(`
    CREATE TABLE schema_compat (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO schema_compat VALUES ('min_reader_version', ${OURS + 1});
  `)
  expect(() => openDatabase(path)).toThrow(NEWER)
  expect(() => openDatabaseReadOnly(path)).toThrow(NEWER)
  expect(versionOf(path)).toBe(OURS + 1)
  // One this build meets is fine.
  const ok = newerDb(`
    CREATE TABLE schema_compat (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO schema_compat VALUES ('min_reader_version', ${OURS});
  `)
  expect(() => openDatabase(ok).close()).not.toThrow()
})

test('read-only opens follow the same rules', () => {
  const path = newerDb(ADDITIVE)
  const writer = openDatabase(path)
  seedMailbox(writer, ACCOUNT.id, ACCOUNT.email, { path: 'INBOX', specialUse: '\\Inbox' }, { count: 2, subject: 'Hi' })
  writer.run('UPDATE messages SET seen = 0')
  writer.close()
  const reader = openDatabaseReadOnly(path)
  expect(countInboxUnread(reader, ACCOUNT)).toBe(2)
  reader.close()
  expect(versionOf(path)).toBe(OURS + 1)
  expect(() => openDatabaseReadOnly(newerDb(DROPPED_SNIPPET))).toThrow(NEWER)
})

