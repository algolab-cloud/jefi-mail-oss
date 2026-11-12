import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { configDir } from '../paths'

// ---------------------------------------------------------------------------
// The engine's local store: source of truth for synced mail, opened only by the engine worker.
// Shaped after IMAP, not the UI: one row per message, linked to every mailbox that holds a copy
// (so Gmail labels and All Mail don't duplicate it). The UI's MailThread is derived from this.
//
// Migrations are append-only: each entry runs once, in a transaction, tracked by PRAGMA user_version.
// Never edit a shipped migration; add a new one.
//
// Forward compatibility: a mail.db a newer Jefi migrated past this build still opens, unmigrated and
// with its user_version untouched, when it holds everything this build uses (see forwardCompatProblem).
// So migrations should be additive: new tables, and new columns that are nullable or have a default.
// A migration that breaks older builds anyway (drops or retypes a column, changes what a row means)
// must also record the oldest build that can still use the result:
//   CREATE TABLE IF NOT EXISTS schema_compat (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
//   INSERT OR REPLACE INTO schema_compat VALUES ('min_reader_version', <this migration's number>);
// Older builds refuse a mailbox whose min_reader_version is above their own schema version.
// ---------------------------------------------------------------------------


// Conversation summaries (migration 16). The best-ranked built-in mailbox holding any message of a
// conversation decides where it's listed: threads.ts FOLDER_RANK, written out here because a shipped
// migration must not change when that list does (a test keeps the two in step).
const RANK = `CASE mb.special_use WHEN '\\Inbox' THEN 1 WHEN '\\Drafts' THEN 2 WHEN '\\Archive' THEN 3 WHEN '\\All' THEN 4
  WHEN '\\Sent' THEN 5 WHEN '\\Junk' THEN 6 WHEN '\\Trash' THEN 7 END`
const PLACE = `CASE min(${RANK}) WHEN 1 THEN 'inbox' WHEN 2 THEN 'drafts' WHEN 3 THEN 'archive' WHEN 4 THEN 'archive'
  WHEN 5 THEN 'sent' WHEN 6 THEN 'spam' WHEN 7 THEN 'trash' END`
/** Messages the list shows: the server copies of Jefi's own drafts stand aside for the draft row. */
const SHOWN = `(m.message_id IS NULL OR (NOT EXISTS (SELECT 1 FROM drafts d WHERE d.account_id = m.account_id AND d.remote_message_id = m.message_id)
  AND NOT EXISTS (SELECT 1 FROM draft_removals r WHERE r.account_id = m.account_id AND r.message_id = m.message_id)))`
const SUMMARY = `max(m.date), ${PLACE} FROM messages m
  LEFT JOIN message_mailboxes mm ON mm.message_id = m.id LEFT JOIN mailboxes mb ON mb.id = mm.mailbox_id`

/**
 * Rebuilds one conversation's summary from a message row's account, thread and id (`new` or `old`
 * in a trigger). The accounts join keeps a cascade from a deleted account from writing rows back.
 */
const refreshKey = (row: string) => `
    DELETE FROM conversations WHERE account_id = ${row}.account_id AND key = COALESCE(${row}.thread_id, 'm' || ${row}.id);
    INSERT INTO conversations (account_id, key, thread_id, message_id, latest, place)
      SELECT m.account_id, ${row}.thread_id, ${row}.thread_id, NULL, ${SUMMARY}
       WHERE ${row}.thread_id IS NOT NULL AND m.account_id = ${row}.account_id AND m.thread_id = ${row}.thread_id AND ${SHOWN}
         AND EXISTS (SELECT 1 FROM accounts WHERE id = ${row}.account_id)
      HAVING count(*) > 0;
    INSERT INTO conversations (account_id, key, thread_id, message_id, latest, place)
      SELECT m.account_id, 'm' || m.id, NULL, m.id, ${SUMMARY}
       WHERE ${row}.thread_id IS NULL AND m.id = ${row}.id AND m.thread_id IS NULL AND ${SHOWN}
         AND EXISTS (SELECT 1 FROM accounts WHERE id = m.account_id)
      HAVING count(*) > 0;`

/** Rebuilds the summaries of every conversation holding a message `s` that matches `where`. */
const refreshWhere = (where: string) => `
    DELETE FROM conversations WHERE (account_id, key) IN (SELECT s.account_id, COALESCE(s.thread_id, 'm' || s.id) FROM messages s WHERE ${where});
    INSERT INTO conversations (account_id, key, thread_id, message_id, latest, place)
      SELECT k.account_id, k.thread_id, k.thread_id, NULL, max(m.date), ${PLACE}
        FROM (SELECT DISTINCT s.account_id, s.thread_id FROM messages s WHERE ${where} AND s.thread_id IS NOT NULL) k
       CROSS JOIN messages m ON m.account_id = k.account_id AND m.thread_id = k.thread_id
        LEFT JOIN message_mailboxes mm ON mm.message_id = m.id LEFT JOIN mailboxes mb ON mb.id = mm.mailbox_id
       WHERE ${SHOWN} AND EXISTS (SELECT 1 FROM accounts WHERE id = k.account_id)
       GROUP BY k.account_id, k.thread_id;
    INSERT INTO conversations (account_id, key, thread_id, message_id, latest, place)
      SELECT m.account_id, 'm' || m.id, NULL, m.id, ${SUMMARY}
       WHERE m.id IN (SELECT s.id FROM messages s WHERE ${where} AND s.thread_id IS NULL) AND ${SHOWN}
         AND EXISTS (SELECT 1 FROM accounts WHERE id = m.account_id)
       GROUP BY m.id;`

/**
 * Deferred conversation summaries (migration 25, lume-1t4). While conversation_defer holds its row,
 * the per-row triggers below only note which conversations they would have rebuilt, and
 * FLUSH_CONVERSATIONS rebuilds each of those once. Every trigger rebuilds its keys whole from the
 * current rows, so rebuilding the same keys once at the end leaves the same table. Builds from before
 * migration 25 never set the flag, so on a newer mailbox their triggers still rebuild row by row.
 */
const DEFERRING = 'EXISTS (SELECT 1 FROM conversation_defer)'
const dirtyKey = (row: string) => `INSERT OR IGNORE INTO conversation_dirty (account_id, key) VALUES (${row}.account_id, COALESCE(${row}.thread_id, 'm' || ${row}.id));`
const dirtyWhere = (where: string) => `INSERT OR IGNORE INTO conversation_dirty (account_id, key) SELECT s.account_id, COALESCE(s.thread_id, 'm' || s.id) FROM messages s WHERE ${where};`
const MESSAGE_CHANGED = 'old.account_id IS NOT new.account_id OR old.thread_id IS NOT new.thread_id OR old.date IS NOT new.date OR old.message_id IS NOT new.message_id'
const LINK_CHANGED = 'old.mailbox_id IS NOT new.mailbox_id OR old.message_id IS NOT new.message_id'

/** Rebuilds every conversation noted while deferred, as refreshKey would each, and ends the deferral. */
export const FLUSH_CONVERSATIONS = `
  DELETE FROM conversations WHERE (account_id, key) IN (SELECT account_id, key FROM conversation_dirty);
  INSERT INTO conversations (account_id, key, thread_id, message_id, latest, place)
    SELECT k.account_id, k.key, k.key, NULL, max(m.date), ${PLACE}
      FROM conversation_dirty k
     CROSS JOIN messages m ON m.account_id = k.account_id AND m.thread_id = k.key
      LEFT JOIN message_mailboxes mm ON mm.message_id = m.id LEFT JOIN mailboxes mb ON mb.id = mm.mailbox_id
     WHERE ${SHOWN} AND EXISTS (SELECT 1 FROM accounts WHERE id = k.account_id)
     GROUP BY k.account_id, k.key;
  INSERT INTO conversations (account_id, key, thread_id, message_id, latest, place)
    SELECT m.account_id, 'm' || m.id, NULL, m.id, max(m.date), ${PLACE}
      FROM conversation_dirty k
     CROSS JOIN messages m ON m.id = CAST(substr(k.key, 2) AS INTEGER) AND 'm' || m.id = k.key AND m.account_id = k.account_id AND m.thread_id IS NULL
      LEFT JOIN message_mailboxes mm ON mm.message_id = m.id LEFT JOIN mailboxes mb ON mb.id = mm.mailbox_id
     WHERE ${SHOWN} AND EXISTS (SELECT 1 FROM accounts WHERE id = m.account_id)
     GROUP BY m.id;
  DELETE FROM conversation_dirty;
  DELETE FROM conversation_defer;`

export const MIGRATIONS: string[] = [
  // 1 — core mail schema
  `
  CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE mailboxes (
    id             INTEGER PRIMARY KEY,
    account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path           TEXT NOT NULL,
    delimiter      TEXT,
    special_use    TEXT,            -- \\Inbox \\Sent \\Drafts \\Trash \\Junk \\Archive \\All
    uidvalidity    INTEGER,         -- a change means every cached UID for this mailbox is void
    uidnext        INTEGER,
    highestmodseq  INTEGER,         -- CONDSTORE/QRESYNC checkpoint
    last_uid       INTEGER NOT NULL DEFAULT 0,
    synced_at      INTEGER,
    UNIQUE (account_id, path)
  );

  CREATE TABLE messages (
    id               INTEGER PRIMARY KEY,
    account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id       TEXT,          -- RFC 5322 Message-ID header
    gm_msgid         TEXT,          -- Gmail X-GM-MSGID: stable across labels
    thread_id        TEXT,          -- assigned by threading (lume-5ny.5)
    subject          TEXT NOT NULL DEFAULT '',
    from_name        TEXT,
    from_email       TEXT,
    to_json          TEXT NOT NULL DEFAULT '[]',
    cc_json          TEXT NOT NULL DEFAULT '[]',
    bcc_json         TEXT NOT NULL DEFAULT '[]',
    reply_to_json    TEXT NOT NULL DEFAULT '[]',
    in_reply_to      TEXT,
    references_json  TEXT NOT NULL DEFAULT '[]',
    date             INTEGER NOT NULL,        -- epoch ms
    size             INTEGER,
    snippet          TEXT NOT NULL DEFAULT '',
    has_attachments  INTEGER NOT NULL DEFAULT 0,
    seen             INTEGER NOT NULL DEFAULT 0,
    flagged          INTEGER NOT NULL DEFAULT 0,
    answered         INTEGER NOT NULL DEFAULT 0,
    draft            INTEGER NOT NULL DEFAULT 0,
    keywords_json    TEXT NOT NULL DEFAULT '[]'
  );
  CREATE UNIQUE INDEX messages_gm_msgid ON messages (account_id, gm_msgid) WHERE gm_msgid IS NOT NULL;
  CREATE INDEX messages_message_id ON messages (account_id, message_id);
  CREATE INDEX messages_thread ON messages (account_id, thread_id, date);
  CREATE INDEX messages_date ON messages (account_id, date DESC);

  -- Which mailboxes hold a copy of a message, under which UID.
  CREATE TABLE message_mailboxes (
    mailbox_id  INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    uid         INTEGER NOT NULL,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    modseq      INTEGER,
    PRIMARY KEY (mailbox_id, uid)
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX message_mailboxes_message ON message_mailboxes (message_id, mailbox_id);

  CREATE TABLE bodies (
    message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    text        TEXT,
    html        TEXT,
    fetched_at  INTEGER NOT NULL
  );

  CREATE TABLE attachments (
    id            INTEGER PRIMARY KEY,
    message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    part          TEXT,             -- IMAP body part, for fetching content on demand
    filename      TEXT,
    content_type  TEXT,
    content_id    TEXT,
    size          INTEGER
  );
  CREATE INDEX attachments_message ON attachments (message_id);

  -- Local changes not yet applied on the server, replayed in order on reconnect.
  CREATE TABLE pending_ops (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,    -- flags | move | delete | labels
    payload_json  TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX pending_ops_account ON pending_ops (account_id, id);

  -- Immutable snapshot of each message handed to SMTP. Survives restarts; 'sending' rows found at
  -- startup were interrupted and go back to 'queued'.
  CREATE TABLE outbound_queue (
    id               TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mail_json        TEXT NOT NULL,
    in_reply_to      TEXT,
    state            TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX outbound_queue_state ON outbound_queue (state, next_attempt_at);

  CREATE TABLE drafts (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mail_json   TEXT NOT NULL,
    remote_uid  INTEGER,            -- copy in the server's Drafts mailbox, if synced (lume-zjv.4)
    updated_at  INTEGER NOT NULL
  );
  `,

  // 2 — threading: find replies to a message by its Message-ID
  `
  CREATE INDEX messages_in_reply_to ON messages (account_id, in_reply_to);
  `,

  // 3 — Gmail labels (X-GM-LABELS): one row per user label on a message
  `
  CREATE TABLE message_labels (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    PRIMARY KEY (message_id, label)
  ) WITHOUT ROWID;
  CREATE INDEX message_labels_label ON message_labels (label);
  `,

  // 4 — mailbox tools: unsubscribe headers (RFC 2369 / RFC 8058) and grouping by sender
  `
  ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
  ALTER TABLE messages ADD COLUMN list_unsubscribe_post INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX messages_sender ON messages (account_id, from_email);
  `,

  // 5 — mail rules, applied by the engine to new mail (and on demand to existing mail)
  `
  CREATE TABLE rules (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0,
    rule_json   TEXT NOT NULL
  );
  `,

  // 6 — Screener: first-time senders wait for a decision; mail from before it was on is exempt
  `
  CREATE TABLE screener (
    account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    enabled_at  INTEGER NOT NULL
  );
  CREATE TABLE sender_verdicts (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    verdict     TEXT NOT NULL CHECK (verdict IN ('allow', 'block')),
    PRIMARY KEY (account_id, email)
  ) WITHOUT ROWID;
  `,

  // 7 — snooze: a conversation is archived until \`until\`, then comes back to the Inbox unread
  `
  CREATE TABLE snoozes (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id   TEXT NOT NULL,
    until       INTEGER NOT NULL,
    PRIMARY KEY (account_id, thread_id)
  ) WITHOUT ROWID;
  `,

  // 8 — full-text search: one row per message (rowid = messages.id), kept current by triggers
  `
  CREATE VIRTUAL TABLE message_search USING fts5(subject, sender, recipients, body, tokenize = 'unicode61 remove_diacritics 2');
  INSERT INTO message_search (rowid, subject, sender, recipients, body)
    SELECT m.id, m.subject, COALESCE(m.from_name, '') || ' ' || COALESCE(m.from_email, ''), m.to_json || ' ' || m.cc_json, COALESCE(b.text, '')
      FROM messages m LEFT JOIN bodies b ON b.message_id = m.id;
  CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
    INSERT INTO message_search (rowid, subject, sender, recipients, body)
    VALUES (new.id, new.subject, COALESCE(new.from_name, '') || ' ' || COALESCE(new.from_email, ''), new.to_json || ' ' || new.cc_json, '');
  END;
  CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
    DELETE FROM message_search WHERE rowid = old.id;
  END;
  CREATE TRIGGER message_search_body AFTER INSERT ON bodies BEGIN
    UPDATE message_search SET body = COALESCE(new.text, '') WHERE rowid = new.message_id;
  END;
  CREATE TRIGGER message_search_body_update AFTER UPDATE OF text ON bodies BEGIN
    UPDATE message_search SET body = COALESCE(new.text, '') WHERE rowid = new.message_id;
  END;
  `,

  // 9 — search follows header edits too (a re-fetched envelope, a corrected sender), and a dropped body
  `
  CREATE TRIGGER message_search_update AFTER UPDATE OF subject, from_name, from_email, to_json, cc_json ON messages BEGIN
    UPDATE message_search
       SET subject = new.subject,
           sender = COALESCE(new.from_name, '') || ' ' || COALESCE(new.from_email, ''),
           recipients = new.to_json || ' ' || new.cc_json
     WHERE rowid = new.id;
  END;
  CREATE TRIGGER message_search_body_delete AFTER DELETE ON bodies BEGIN
    UPDATE message_search SET body = '' WHERE rowid = old.message_id;
  END;
  `,

  // 10 — remote Drafts (lume-zjv.4): each draft's copy in the server's Drafts mailbox is found by a
  // Message-ID of its own; copies of drafts that were sent or discarded wait here to be removed
  `
  ALTER TABLE drafts ADD COLUMN remote_message_id TEXT;
  ALTER TABLE drafts ADD COLUMN remote_synced_at INTEGER;
  CREATE TABLE draft_removals (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id  TEXT NOT NULL,
    PRIMARY KEY (account_id, message_id)
  ) WITHOUT ROWID;
  `,

  // 11 — distinguish permanent delivery failures from a temporary failure whose retry budget ended
  `
  ALTER TABLE outbound_queue ADD COLUMN failure_kind TEXT CHECK (failure_kind IN ('temporary', 'permanent', 'exhausted'));
  UPDATE outbound_queue SET failure_kind = 'temporary' WHERE state = 'failed' AND next_attempt_at IS NOT NULL;
  UPDATE outbound_queue SET failure_kind = 'permanent' WHERE state = 'failed' AND next_attempt_at IS NULL;
  `,

  // 12 — STATUS change detection (lume-75z.4): the message count a folder had when its last sync
  // finished, so a later sync can skip a folder whose STATUS shows nothing changed. NULL until a sync
  // completes, and cleared by any partial one.
  `
  ALTER TABLE mailboxes ADD COLUMN exists_count INTEGER;
  `,

  // 13 — bodies without their attachments (lume-75z.9): an attachment's size can come from
  // BODYSTRUCTURE, which gives the encoded size on the server, so only an estimate of the decoded
  // one. An estimated size is shown, but never checked against downloaded bytes.
  `
  ALTER TABLE attachments ADD COLUMN size_estimated INTEGER NOT NULL DEFAULT 0;
  `,

  // 14 — duplicate server copies (lume-6fz): a folder can hold two UIDs with the same Message-ID.
  // message_mailboxes keeps one link per message per folder; the other UIDs are recorded here so
  // sync counts them as known instead of refetching them and flip-flopping the link forever.
  `
  CREATE TABLE mailbox_aliases (
    mailbox_id  INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    uid         INTEGER NOT NULL,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (mailbox_id, uid)
  ) WITHOUT ROWID;
  CREATE INDEX mailbox_aliases_message ON mailbox_aliases (message_id, mailbox_id);
  `,

  // 15 — list revisions (lume-2vz): a per-account counter bumped by every change the conversation list
  // can show, so a snapshot can tell "nothing changed" without scanning, and a paged view can ask
  // which conversations changed since the revision it was loaded at. Each touched message is stamped
  // with the revision; conversations that lost their key (deleted, re-threaded) are logged in
  // list_removals. list_reset_rev marks changes too broad to stamp (Screener on/off, a mailbox's
  // role): a view loaded before it reloads instead of patching. The Outbox has no trigger: its code
  // relies on exact change counts, which bun reports with trigger writes included, and it isn't paged.
  `
  ALTER TABLE accounts ADD COLUMN list_rev INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN list_reset_rev INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN list_rev INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX messages_list_rev ON messages (account_id, list_rev);
  CREATE TABLE list_removals (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    key         TEXT NOT NULL
  );
  CREATE INDEX list_removals_rev ON list_removals (account_id, rev);

  CREATE TRIGGER list_rev_message_insert AFTER INSERT ON messages BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id) WHERE id = new.id;
  END;
  -- WHEN: sync rewrites every message's flags each pass, mostly with the values already stored.
  CREATE TRIGGER list_rev_message_update AFTER UPDATE OF thread_id, subject, from_name, from_email, to_json, cc_json, date, snippet,
      has_attachments, seen, flagged, message_id, list_unsubscribe ON messages
    WHEN old.thread_id IS NOT new.thread_id OR old.subject IS NOT new.subject OR old.from_name IS NOT new.from_name
      OR old.from_email IS NOT new.from_email OR old.to_json IS NOT new.to_json OR old.cc_json IS NOT new.cc_json
      OR old.date IS NOT new.date OR old.snippet IS NOT new.snippet OR old.has_attachments IS NOT new.has_attachments
      OR old.seen IS NOT new.seen OR old.flagged IS NOT new.flagged OR old.message_id IS NOT new.message_id
      OR old.list_unsubscribe IS NOT new.list_unsubscribe
  BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id) WHERE id = new.id;
    INSERT INTO list_removals (account_id, rev, key)
      SELECT new.account_id, list_rev, COALESCE(old.thread_id, 'm' || old.id) FROM accounts
       WHERE id = new.account_id AND old.thread_id IS NOT new.thread_id;
  END;
  CREATE TRIGGER list_rev_message_delete AFTER DELETE ON messages BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = old.account_id;
    INSERT INTO list_removals (account_id, rev, key) SELECT old.account_id, list_rev, COALESCE(old.thread_id, 'm' || old.id) FROM accounts WHERE id = old.account_id;
  END;

  CREATE TRIGGER list_rev_link_insert AFTER INSERT ON message_mailboxes BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = (SELECT account_id FROM messages WHERE id = new.message_id);
    UPDATE messages SET list_rev = (SELECT a.list_rev FROM accounts a WHERE a.id = messages.account_id) WHERE id = new.message_id;
  END;
  CREATE TRIGGER list_rev_link_delete AFTER DELETE ON message_mailboxes BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = (SELECT account_id FROM messages WHERE id = old.message_id);
    UPDATE messages SET list_rev = (SELECT a.list_rev FROM accounts a WHERE a.id = messages.account_id) WHERE id = old.message_id;
  END;
  CREATE TRIGGER list_rev_label_insert AFTER INSERT ON message_labels BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = (SELECT account_id FROM messages WHERE id = new.message_id);
    UPDATE messages SET list_rev = (SELECT a.list_rev FROM accounts a WHERE a.id = messages.account_id) WHERE id = new.message_id;
  END;
  CREATE TRIGGER list_rev_label_delete AFTER DELETE ON message_labels BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = (SELECT account_id FROM messages WHERE id = old.message_id);
    UPDATE messages SET list_rev = (SELECT a.list_rev FROM accounts a WHERE a.id = messages.account_id) WHERE id = old.message_id;
  END;

  -- Drafts stand in for their server copies, which drop out of the list while the draft exists.
  CREATE TRIGGER list_rev_draft_insert AFTER INSERT ON drafts BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id)
     WHERE account_id = new.account_id AND message_id = new.remote_message_id;
  END;
  CREATE TRIGGER list_rev_draft_update AFTER UPDATE ON drafts BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id)
     WHERE account_id = new.account_id AND message_id IN (old.remote_message_id, new.remote_message_id);
  END;
  CREATE TRIGGER list_rev_draft_delete AFTER DELETE ON drafts BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = old.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = old.account_id)
     WHERE account_id = old.account_id AND message_id = old.remote_message_id;
  END;
  CREATE TRIGGER list_rev_draft_removal_insert AFTER INSERT ON draft_removals BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id) WHERE account_id = new.account_id AND message_id = new.message_id;
  END;
  CREATE TRIGGER list_rev_draft_removal_delete AFTER DELETE ON draft_removals BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = old.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = old.account_id) WHERE account_id = old.account_id AND message_id = old.message_id;
  END;

  -- Snoozes are keyed by the UI's thread id: accountId:key, key a thread_id or m<message id>.
  CREATE TRIGGER list_rev_snooze_insert AFTER INSERT ON snoozes BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id)
     WHERE account_id = new.account_id AND thread_id = substr(new.thread_id, length(new.account_id) + 2);
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id)
     WHERE id = CAST(substr(new.thread_id, length(new.account_id) + 3) AS INTEGER) AND account_id = new.account_id
       AND thread_id IS NULL AND 'm' || id = substr(new.thread_id, length(new.account_id) + 2);
  END;
  CREATE TRIGGER list_rev_snooze_update AFTER UPDATE ON snoozes BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
  END;
  CREATE TRIGGER list_rev_snooze_delete AFTER DELETE ON snoozes BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = old.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = old.account_id)
     WHERE account_id = old.account_id AND thread_id = substr(old.thread_id, length(old.account_id) + 2);
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = old.account_id)
     WHERE id = CAST(substr(old.thread_id, length(old.account_id) + 3) AS INTEGER) AND account_id = old.account_id
       AND thread_id IS NULL AND 'm' || id = substr(old.thread_id, length(old.account_id) + 2);
  END;

  -- A verdict changes every conversation from that sender.
  CREATE TRIGGER list_rev_verdict_insert AFTER INSERT ON sender_verdicts BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id) WHERE account_id = new.account_id AND lower(from_email) = lower(new.email);
  END;
  CREATE TRIGGER list_rev_verdict_update AFTER UPDATE ON sender_verdicts BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id) WHERE account_id = new.account_id AND lower(from_email) = lower(new.email);
  END;
  CREATE TRIGGER list_rev_verdict_delete AFTER DELETE ON sender_verdicts BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = old.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = old.account_id) WHERE account_id = old.account_id AND lower(from_email) = lower(old.email);
  END;

  -- Too broad to stamp: every conversation may look different.
  CREATE TRIGGER list_rev_screener_insert AFTER INSERT ON screener BEGIN
    UPDATE accounts SET list_rev = list_rev + 1, list_reset_rev = list_rev + 1 WHERE id = new.account_id;
  END;
  CREATE TRIGGER list_rev_screener_delete AFTER DELETE ON screener BEGIN
    UPDATE accounts SET list_rev = list_rev + 1, list_reset_rev = list_rev + 1 WHERE id = old.account_id;
  END;
  CREATE TRIGGER list_rev_mailbox_update AFTER UPDATE OF path, special_use ON mailboxes
    WHEN old.path IS NOT new.path OR old.special_use IS NOT new.special_use
  BEGIN
    UPDATE accounts SET list_rev = list_rev + 1, list_reset_rev = list_rev + 1 WHERE id = new.account_id;
  END;
  `,

  // 16 — conversation summaries (lume-cor): one row per conversation the list can show, with its
  // latest date and the built-in mailbox it's listed in (NULL when it's only in plain folders or in
  // none), kept by triggers on everything those depend on. A view page or the account window reads
  // its keys off an index here instead of grouping every message of the account per page.
  `
  CREATE TABLE conversations (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,     -- thread_id, or m<id> for a message not threaded yet
    thread_id   TEXT,
    message_id  INTEGER,           -- that message, when thread_id is NULL
    latest      INTEGER NOT NULL,
    place       TEXT,              -- inbox | drafts | archive | sent | spam | trash
    PRIMARY KEY (account_id, key)
  ) WITHOUT ROWID;
  CREATE INDEX conversations_latest ON conversations (account_id, latest DESC, key DESC);
  CREATE INDEX conversations_place ON conversations (account_id, place, latest DESC, key DESC);
  CREATE INDEX drafts_remote ON drafts (account_id, remote_message_id);
  CREATE INDEX messages_flagged ON messages (account_id) WHERE flagged = 1;

  INSERT INTO conversations (account_id, key, thread_id, message_id, latest, place)
    SELECT m.account_id, COALESCE(m.thread_id, 'm' || m.id), m.thread_id, CASE WHEN m.thread_id IS NULL THEN m.id END, ${SUMMARY}
     WHERE ${SHOWN} AND EXISTS (SELECT 1 FROM accounts WHERE id = m.account_id)
     GROUP BY m.account_id, COALESCE(m.thread_id, 'm' || m.id);

  CREATE TRIGGER conversation_message_insert AFTER INSERT ON messages BEGIN ${refreshKey('new')}
  END;
  CREATE TRIGGER conversation_message_update AFTER UPDATE OF account_id, thread_id, date, message_id ON messages
    WHEN old.account_id IS NOT new.account_id OR old.thread_id IS NOT new.thread_id OR old.date IS NOT new.date OR old.message_id IS NOT new.message_id
  BEGIN ${refreshKey('old')} ${refreshKey('new')}
  END;
  CREATE TRIGGER conversation_message_delete AFTER DELETE ON messages BEGIN ${refreshKey('old')}
  END;

  CREATE TRIGGER conversation_link_insert AFTER INSERT ON message_mailboxes BEGIN ${refreshWhere('s.id = new.message_id')}
  END;
  CREATE TRIGGER conversation_link_update AFTER UPDATE OF mailbox_id, message_id ON message_mailboxes
    WHEN old.mailbox_id IS NOT new.mailbox_id OR old.message_id IS NOT new.message_id
  BEGIN ${refreshWhere('s.id IN (old.message_id, new.message_id)')}
  END;
  CREATE TRIGGER conversation_link_delete AFTER DELETE ON message_mailboxes BEGIN ${refreshWhere('s.id = old.message_id')}
  END;
  CREATE TRIGGER conversation_mailbox_update AFTER UPDATE OF special_use ON mailboxes WHEN old.special_use IS NOT new.special_use
  BEGIN ${refreshWhere('s.id IN (SELECT message_id FROM message_mailboxes WHERE mailbox_id = new.id)')}
  END;

  CREATE TRIGGER conversation_draft_insert AFTER INSERT ON drafts WHEN new.remote_message_id IS NOT NULL
  BEGIN ${refreshWhere('s.account_id = new.account_id AND s.message_id = new.remote_message_id')}
  END;
  CREATE TRIGGER conversation_draft_update AFTER UPDATE OF account_id, remote_message_id ON drafts
    WHEN old.account_id IS NOT new.account_id OR old.remote_message_id IS NOT new.remote_message_id
  BEGIN
    ${refreshWhere('s.account_id = old.account_id AND s.message_id = old.remote_message_id')}
    ${refreshWhere('s.account_id = new.account_id AND s.message_id = new.remote_message_id')}
  END;
  CREATE TRIGGER conversation_draft_delete AFTER DELETE ON drafts WHEN old.remote_message_id IS NOT NULL
  BEGIN ${refreshWhere('s.account_id = old.account_id AND s.message_id = old.remote_message_id')}
  END;
  CREATE TRIGGER conversation_draft_removal_insert AFTER INSERT ON draft_removals
  BEGIN ${refreshWhere('s.account_id = new.account_id AND s.message_id = new.message_id')}
  END;
  CREATE TRIGGER conversation_draft_removal_delete AFTER DELETE ON draft_removals
  BEGIN ${refreshWhere('s.account_id = old.account_id AND s.message_id = old.message_id')}
  END;
  `,

  // 17 — calendars and notes (lume-fwl.1): see docs/calendar-notes-architecture.md. Calendars,
  // events and notes belong to no account and outlive account removal. An event's account_id is only
  // the identity it answers invites as; links keep a snapshot of what they pointed at, which is all a
  // link keeps once its account is gone. Interop is by email (iTIP), hence uid/sequence/partstat.
  `
  CREATE TABLE calendars (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'subscription')),
    name          TEXT NOT NULL,
    color         TEXT NOT NULL,
    can_write     INTEGER NOT NULL DEFAULT 1,
    is_default    INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0,
    url           TEXT,                -- subscription: its iCal URL (reserved: nothing fetches yet)
    sync_state    TEXT,                -- subscription: opaque refresh state (ETag, Last-Modified)
    refreshed_at  INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  INSERT INTO calendars (id, name, color, is_default, created_at, updated_at)
    VALUES ('local', 'Personal', '#5b7cfa', 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

  CREATE TABLE events (
    id                   TEXT PRIMARY KEY,
    calendar_id          TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    uid                  TEXT NOT NULL,        -- iCalendar UID; a series and its exceptions share it
    sequence             INTEGER NOT NULL DEFAULT 0,
    account_id           TEXT,                 -- the account it sends / answers invites as
    title                TEXT NOT NULL DEFAULT '',
    start_at             INTEGER NOT NULL,     -- epoch ms UTC; all-day: UTC midnight
    end_at               INTEGER NOT NULL,     -- exclusive
    all_day              INTEGER NOT NULL DEFAULT 0,
    time_zone            TEXT,                 -- IANA
    location             TEXT,
    description          TEXT,
    url                  TEXT,
    status               TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    organizer_json       TEXT,
    attendees_json       TEXT NOT NULL DEFAULT '[]',
    recurrence           TEXT,                 -- RRULE of a series
    exdates_json         TEXT NOT NULL DEFAULT '[]',
    recur_end            INTEGER,              -- a series' last end; NULL while it has no end
    recurring_master_id  TEXT,
    recurrence_id        INTEGER,              -- an exception's original start (RECURRENCE-ID)
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE INDEX events_range ON events (calendar_id, start_at);
  CREATE INDEX events_series ON events (calendar_id, recur_end) WHERE recurrence IS NOT NULL;
  CREATE INDEX events_master ON events (recurring_master_id) WHERE recurring_master_id IS NOT NULL;
  CREATE UNIQUE INDEX events_uid ON events (calendar_id, uid, COALESCE(recurrence_id, -1));
  CREATE INDEX events_uid_lookup ON events (uid);
  CREATE INDEX events_account ON events (account_id) WHERE account_id IS NOT NULL;

  -- Mail an event is about ('related') or the invite it came from ('invite'). account_id and the
  -- refs go NULL when the account is removed.
  CREATE TABLE event_links (
    id                 TEXT PRIMARY KEY,
    event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL CHECK (kind IN ('thread', 'message')),
    role               TEXT NOT NULL DEFAULT 'related' CHECK (role IN ('related', 'invite')),
    account_id         TEXT,
    target_ref         TEXT,                   -- UI thread id or message id
    message_id_header  TEXT,
    snapshot_json      TEXT NOT NULL DEFAULT '{}',
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX event_links_event ON event_links (event_id);
  CREATE INDEX event_links_mail ON event_links (account_id, target_ref);
  CREATE INDEX event_links_header ON event_links (account_id, message_id_header);

  CREATE TABLE notes (
    n           INTEGER PRIMARY KEY,           -- search rowid: stable, unlike an implicit one
    id          TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX notes_order ON notes (pinned DESC, updated_at DESC);
  CREATE VIRTUAL TABLE note_search USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER note_search_insert AFTER INSERT ON notes BEGIN
    INSERT INTO note_search (rowid, title, body) VALUES (new.n, new.title, new.body);
  END;
  CREATE TRIGGER note_search_update AFTER UPDATE OF title, body ON notes BEGIN
    UPDATE note_search SET title = new.title, body = new.body WHERE rowid = new.n;
  END;
  CREATE TRIGGER note_search_delete AFTER DELETE ON notes BEGIN
    DELETE FROM note_search WHERE rowid = old.n;
  END;

  -- Links point by kind: a thread or message (account_id + target_ref + Message-ID header), an event
  -- (target_ref = event id) or a contact (target_ref = email). Removing the account keeps the row.
  CREATE TABLE note_links (
    id                 TEXT PRIMARY KEY,
    note_id            TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL CHECK (kind IN ('thread', 'message', 'event', 'contact')),
    account_id         TEXT,
    target_ref         TEXT,
    message_id_header  TEXT,
    snapshot_json      TEXT NOT NULL DEFAULT '{}',
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX note_links_note ON note_links (note_id);
  CREATE INDEX note_links_target ON note_links (kind, account_id, target_ref);
  CREATE INDEX note_links_header ON note_links (account_id, message_id_header);

  -- text/calendar parts of received mail, raw, kept when bodies are stored (small ones only).
  CREATE TABLE invites (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    method      TEXT,
    filename    TEXT,
    ics         TEXT NOT NULL,
    PRIMARY KEY (message_id, idx)
  ) WITHOUT ROWID;
  `,
  // 18: what became of each received invite (calendar/invites.ts), so a message is applied to the
  // calendar once: 'applied', 'pending' (from Junk or a blocked or screened sender: waits for the
  // person), 'stale' (an older SEQUENCE than the calendar has), 'own' (our own copy) or 'ignored'.
  `
  CREATE TABLE invite_state (
    message_id    INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    state         TEXT NOT NULL,
    processed_at  INTEGER NOT NULL
  );
  `,
  // 19: event reminders (lume-d6u.9). An event's alerts as minutes before its start (NULL: the
  // person's default for its kind; '[]': none), and each reminder that already fired, so a restart,
  // a re-plan or the clock going back never shows one twice. Fired rows are pruned by age.
  `
  ALTER TABLE events ADD COLUMN alarms_json TEXT;
  CREATE TABLE reminders_fired (
    event_id          TEXT NOT NULL,
    occurrence_start  INTEGER NOT NULL,
    fire_at           INTEGER NOT NULL,
    fired_at          INTEGER NOT NULL,
    PRIMARY KEY (event_id, occurrence_start, fire_at)
  ) WITHOUT ROWID;
  `,
  // 20: tasks (lume-tsk.1): see docs/tasks-architecture.md. Local like notes, belonging to no account,
  // with the same link model. A date-only due is its UTC midnight with due_all_day = 1. uid is
  // there for a VTODO sync later; remind_at for due reminders (lume-tsk.7).
  `
  CREATE TABLE tasks (
    n             INTEGER PRIMARY KEY,           -- search rowid, as in notes
    id            TEXT NOT NULL UNIQUE,
    uid           TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    notes         TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    due_at        INTEGER,
    due_all_day   INTEGER NOT NULL DEFAULT 0,
    remind_at     INTEGER,
    priority      INTEGER NOT NULL DEFAULT 0,
    origin        TEXT NOT NULL DEFAULT 'manual',
    completed_at  INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX tasks_open ON tasks (status, due_at);
  CREATE INDEX tasks_done ON tasks (status, completed_at DESC);
  CREATE VIRTUAL TABLE task_search USING fts5(title, notes, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER task_search_insert AFTER INSERT ON tasks BEGIN
    INSERT INTO task_search (rowid, title, notes) VALUES (new.n, new.title, new.notes);
  END;
  CREATE TRIGGER task_search_update AFTER UPDATE OF title, notes ON tasks BEGIN
    UPDATE task_search SET title = new.title, notes = new.notes WHERE rowid = new.n;
  END;
  CREATE TRIGGER task_search_delete AFTER DELETE ON tasks BEGIN
    DELETE FROM task_search WHERE rowid = old.n;
  END;

  CREATE TABLE task_links (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL CHECK (kind IN ('thread', 'message', 'event', 'contact')),
    account_id         TEXT,
    target_ref         TEXT,
    message_id_header  TEXT,
    snapshot_json      TEXT NOT NULL DEFAULT '{}',
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX task_links_task ON task_links (task_id);
  CREATE INDEX task_links_target ON task_links (kind, account_id, target_ref);
  CREATE INDEX task_links_header ON task_links (account_id, message_id_header);
  `,
  // 21: tasks like an issue tracker (lume-tsk.10). A workflow status (backlog, todo, in_progress,
  // done, canceled; 'open' becomes todo), priority 0 none / 1 urgent / 2 high / 3 medium / 4 low
  // (a flag becomes high), a number for T-12 ids, projects and labels. SQLite can't change a CHECK,
  // so tasks and task_links are rebuilt with their rows, rowids (the search index keys) and links.
  `
  CREATE TABLE task_projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE task_labels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE tasks_new (
    n             INTEGER PRIMARY KEY,
    id            TEXT NOT NULL UNIQUE,
    uid           TEXT NOT NULL UNIQUE,
    number        INTEGER NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    notes         TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog', 'todo', 'in_progress', 'done', 'canceled')),
    priority      INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    project_id    TEXT REFERENCES task_projects(id) ON DELETE SET NULL,
    due_at        INTEGER,
    due_all_day   INTEGER NOT NULL DEFAULT 0,
    remind_at     INTEGER,
    origin        TEXT NOT NULL DEFAULT 'manual',
    completed_at  INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  INSERT INTO tasks_new (n, id, uid, number, title, notes, status, priority, due_at, due_all_day, remind_at, origin, completed_at, created_at, updated_at)
    SELECT n, id, uid, ROW_NUMBER() OVER (ORDER BY created_at, n), title, notes, CASE status WHEN 'done' THEN 'done' ELSE 'todo' END,
      CASE WHEN priority > 0 THEN 2 ELSE 0 END, due_at, due_all_day, remind_at, origin, completed_at, created_at, updated_at
    FROM tasks;

  CREATE TABLE task_links_new (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT NOT NULL REFERENCES tasks_new(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL CHECK (kind IN ('thread', 'message', 'event', 'contact')),
    account_id         TEXT,
    target_ref         TEXT,
    message_id_header  TEXT,
    snapshot_json      TEXT NOT NULL DEFAULT '{}',
    created_at         INTEGER NOT NULL
  );
  INSERT INTO task_links_new SELECT id, task_id, kind, account_id, target_ref, message_id_header, snapshot_json, created_at FROM task_links;

  -- Links go first, so dropping the old tasks cascades nothing; renaming tasks_new re-points the new links.
  DROP TABLE task_links;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  ALTER TABLE task_links_new RENAME TO task_links;
  CREATE INDEX tasks_status ON tasks (status, due_at);
  CREATE INDEX tasks_project ON tasks (project_id);
  CREATE INDEX task_links_task ON task_links (task_id);
  CREATE INDEX task_links_target ON task_links (kind, account_id, target_ref);
  CREATE INDEX task_links_header ON task_links (account_id, message_id_header);

  CREATE TRIGGER task_search_insert AFTER INSERT ON tasks BEGIN
    INSERT INTO task_search (rowid, title, notes) VALUES (new.n, new.title, new.notes);
  END;
  CREATE TRIGGER task_search_update AFTER UPDATE OF title, notes ON tasks BEGIN
    UPDATE task_search SET title = new.title, notes = new.notes WHERE rowid = new.n;
  END;
  CREATE TRIGGER task_search_delete AFTER DELETE ON tasks BEGIN
    DELETE FROM task_search WHERE rowid = old.n;
  END;

  CREATE TABLE task_label_links (
    task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id  TEXT NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
  ) WITHOUT ROWID;
  CREATE INDEX task_label_links_label ON task_label_links (label_id);
  `,
  // 22: task reminders (lume-tsk.11). A task's alerts as minutes before its due, like an event's
  // (NULL: the person's default for timed or date-only tasks; '[]': none). They fire through the
  // event reminder scheduler and share reminders_fired, keyed by the task id and its due.
  `
  ALTER TABLE tasks ADD COLUMN alarms_json TEXT;
  `,
  // 23: bodies decoded before libqp was patched (lume-02d) lost the high byte of raw 8-bit text in
  // parts labelled quoted-printable: ’ became U+0019. Dropping them lets backfill fetch them again,
  // which rewrites the snippet too.
  `
  DELETE FROM bodies WHERE instr(text, char(25)) > 0;
  `,
  // 24: the highest task number ever given out, so deleting the newest task doesn't hand its T-number
  // to the next one ("never reused", docs/tasks-architecture.md). Older builds ignore it; this one
  // still counts from MAX(number) too, in case one of them added tasks meanwhile.
  `
  CREATE TABLE IF NOT EXISTS task_numbers (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    last  INTEGER NOT NULL
  );
  INSERT INTO task_numbers (id, last) SELECT 1, COALESCE(MAX(number), 0) FROM tasks WHERE true
    ON CONFLICT (id) DO UPDATE SET last = max(last, excluded.last);
  `,
  // 25: bulk writes rebuild each conversation once (lume-1t4). A first sync used to rebuild a
  // conversation's summary on every message insert, mailbox link and thread assignment, which was
  // about half of what storing mail cost. The triggers those writes fire now stand aside while
  // conversation_defer holds a row (deferConversations sets it inside one transaction and flushes
  // before commit) and note the keys in conversation_dirty instead. Additive for older builds: they
  // never set the flag, so these triggers keep rebuilding immediately for them.
  `
  CREATE TABLE IF NOT EXISTS conversation_defer (id INTEGER PRIMARY KEY CHECK (id = 1));
  CREATE TABLE IF NOT EXISTS conversation_dirty (
    account_id  TEXT NOT NULL,
    key         TEXT NOT NULL,
    PRIMARY KEY (account_id, key)
  ) WITHOUT ROWID;

  DROP TRIGGER IF EXISTS conversation_message_insert;
  DROP TRIGGER IF EXISTS conversation_message_update;
  DROP TRIGGER IF EXISTS conversation_link_insert;
  DROP TRIGGER IF EXISTS conversation_link_update;
  DROP TRIGGER IF EXISTS conversation_link_delete;
  DROP TRIGGER IF EXISTS conversation_message_insert_deferred;
  DROP TRIGGER IF EXISTS conversation_message_update_deferred;
  DROP TRIGGER IF EXISTS conversation_link_insert_deferred;
  DROP TRIGGER IF EXISTS conversation_link_update_deferred;
  DROP TRIGGER IF EXISTS conversation_link_delete_deferred;

  CREATE TRIGGER conversation_message_insert AFTER INSERT ON messages WHEN NOT ${DEFERRING} BEGIN ${refreshKey('new')}
  END;
  CREATE TRIGGER conversation_message_update AFTER UPDATE OF account_id, thread_id, date, message_id ON messages
    WHEN (${MESSAGE_CHANGED}) AND NOT ${DEFERRING}
  BEGIN ${refreshKey('old')} ${refreshKey('new')}
  END;
  CREATE TRIGGER conversation_link_insert AFTER INSERT ON message_mailboxes WHEN NOT ${DEFERRING} BEGIN ${refreshWhere('s.id = new.message_id')}
  END;
  CREATE TRIGGER conversation_link_update AFTER UPDATE OF mailbox_id, message_id ON message_mailboxes
    WHEN (${LINK_CHANGED}) AND NOT ${DEFERRING}
  BEGIN ${refreshWhere('s.id IN (old.message_id, new.message_id)')}
  END;
  CREATE TRIGGER conversation_link_delete AFTER DELETE ON message_mailboxes WHEN NOT ${DEFERRING} BEGIN ${refreshWhere('s.id = old.message_id')}
  END;

  CREATE TRIGGER conversation_message_insert_deferred AFTER INSERT ON messages WHEN ${DEFERRING} BEGIN ${dirtyKey('new')}
  END;
  CREATE TRIGGER conversation_message_update_deferred AFTER UPDATE OF account_id, thread_id, date, message_id ON messages
    WHEN (${MESSAGE_CHANGED}) AND ${DEFERRING}
  BEGIN ${dirtyKey('old')} ${dirtyKey('new')}
  END;
  CREATE TRIGGER conversation_link_insert_deferred AFTER INSERT ON message_mailboxes WHEN ${DEFERRING} BEGIN ${dirtyWhere('s.id = new.message_id')}
  END;
  CREATE TRIGGER conversation_link_update_deferred AFTER UPDATE OF mailbox_id, message_id ON message_mailboxes
    WHEN (${LINK_CHANGED}) AND ${DEFERRING}
  BEGIN ${dirtyWhere('s.id IN (old.message_id, new.message_id)')}
  END;
  CREATE TRIGGER conversation_link_delete_deferred AFTER DELETE ON message_mailboxes WHEN ${DEFERRING} BEGIN ${dirtyWhere('s.id = old.message_id')}
  END;
  `,
  // 26: labels Jefi keeps itself, for accounts whose server has none (lume-kvp): everything but Gmail,
  // whose labels stay X-GM-LABELS in message_labels. A label belongs to one account; it's put on
  // messages by their Message-ID ('#' || messages.id for one without), so it survives the message
  // being moved, re-downloaded or copied into another folder. Additive: older builds ignore both
  // tables, and deleting an account cascades to them either way.
  `
  CREATE TABLE IF NOT EXISTS local_labels (
    id          TEXT PRIMARY KEY,          -- lb:<account>:<random>, the UI's label id
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT 'purple',
    created_at  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS local_labels_account ON local_labels (account_id, name);
  CREATE TABLE IF NOT EXISTS local_label_links (
    label_id     TEXT NOT NULL REFERENCES local_labels(id) ON DELETE CASCADE,
    account_id   TEXT NOT NULL,
    message_key  TEXT NOT NULL,            -- the message's Message-ID, or '#' || messages.id
    PRIMARY KEY (label_id, message_key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS local_label_links_message ON local_label_links (account_id, message_key);

  -- A label put on or taken off shows in the list like a Gmail label does (migration 15).
  CREATE TRIGGER IF NOT EXISTS list_rev_local_label_insert AFTER INSERT ON local_label_links BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = new.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id)
     WHERE account_id = new.account_id AND message_id = new.message_key;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = new.account_id)
     WHERE id = CAST(substr(new.message_key, 2) AS INTEGER) AND account_id = new.account_id AND message_id IS NULL AND '#' || id = new.message_key;
  END;
  CREATE TRIGGER IF NOT EXISTS list_rev_local_label_delete AFTER DELETE ON local_label_links BEGIN
    UPDATE accounts SET list_rev = list_rev + 1 WHERE id = old.account_id;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = old.account_id)
     WHERE account_id = old.account_id AND message_id = old.message_key;
    UPDATE messages SET list_rev = (SELECT list_rev FROM accounts WHERE id = old.account_id)
     WHERE id = CAST(substr(old.message_key, 2) AS INTEGER) AND account_id = old.account_id AND message_id IS NULL AND '#' || id = old.message_key;
  END;
  `,

  // 27 — never send twice (lume-cyjz.1): when a send's whole body went to the server. A failure after
  // that with no reply from the server may still have been delivered, so it isn't retried on its own.
  `
  ALTER TABLE outbound_queue ADD COLUMN body_sent_at INTEGER;
  `,

  // 28 — sign-in codes (lume-s3up): the one-time code or magic link found in a message's body when it
  // was stored (src/sign-in-code.ts), as JSON. Mail stored before this has none, which is right: its
  // codes have long expired.
  `
  ALTER TABLE messages ADD COLUMN sign_in TEXT;
  `,

  // 29 — queued changes by message (pending_ops.message_id). Queueing a move looks for an earlier move
  // of the same message to supersede, and syncs ask which messages have changes queued; both used to
  // read and parse every queued op, so a clean-up of thousands was quadratic. A VIRTUAL generated
  // column, so it is filled for rows already queued and for rows an older build inserts (which knows
  // nothing of it). Additive: older builds ignore the column and the index.
  `
  ALTER TABLE pending_ops ADD COLUMN message_id INTEGER GENERATED ALWAYS AS (json_extract(payload_json, '$.messageId')) VIRTUAL;
  CREATE INDEX pending_ops_message ON pending_ops (account_id, message_id);
  `,
]

/**
 * Runs `work` in a transaction (a savepoint inside one already open) with conversation summaries
 * rebuilt once per touched conversation at the end instead of on every row it writes (migration 25).
 * Nothing outside sees the deferral: the flag and the flush commit or roll back with the work.
 */
export function deferConversations<T>(db: MailDatabase, work: () => T): T {
  return db.transaction(() => {
    // Already deferring (a nested call): the outermost one flushes.
    if (db.query('SELECT 1 FROM conversation_defer').get()) return work()
    db.run('INSERT INTO conversation_defer (id) VALUES (1)')
    const result = work()
    db.exec(FLUSH_CONVERSATIONS)
    return result
  })()
}

export function defaultDatabasePath(): string {
  return `${configDir() ?? '.'}/mail.db`
}

export type MailDatabase = Database

/** Opens (creating if needed) the mail database and brings its schema up to date. */
export function openDatabase(path = defaultDatabasePath()): MailDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

/** Connections opened by openDatabaseReadOnly; read paths skip their housekeeping writes on these. */
const readOnly = new WeakSet<MailDatabase>()
export const isReadOnly = (db: MailDatabase) => readOnly.has(db)

/**
 * Opens mail.db for reading only, for the CLI and the MCP server running beside the app (WAL lets
 * them read while it writes). Never creates, migrates or writes: an older schema is an error, and a
 * newer one is used only when it still holds everything this build's queries need.
 */
export function openDatabaseReadOnly(path = defaultDatabasePath()): MailDatabase {
  let db: MailDatabase
  try {
    db = new Database(path, { readonly: true, strict: true })
  } catch (err) {
    throw new Error(`Can't open ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  db.exec('PRAGMA busy_timeout = 5000')
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version < MIGRATIONS.length) {
    db.close()
    throw new Error(`mail.db schema v${version} is older than this build (v${MIGRATIONS.length}); open Jefi once to update it`)
  }
  if (version > MIGRATIONS.length) {
    try {
      acceptNewerSchema(db, version, MIGRATIONS)
    } catch (err) {
      db.close()
      throw err
    }
  }
  readOnly.add(db)
  return db
}

export function migrate(db: MailDatabase, migrations = MIGRATIONS): number {
  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  if (current > migrations.length) {
    // Left exactly as the newer build made it, so that build still finds its own version.
    acceptNewerSchema(db, current, migrations)
    return migrations.length
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version - 1]!)
      db.exec(`PRAGMA user_version = ${version}`)
    })()
  }
  return migrations.length
}

/** Throws unless a mail.db at `version`, beyond what `migrations` reach, is safe for this build to use. */
function acceptNewerSchema(db: MailDatabase, version: number, migrations: string[]) {
  const problem = forwardCompatProblem(db, migrations)
  if (problem) {
    throw new Error(
      `mail.db (schema v${version}) was upgraded by a newer Jefi in a way this version (v${migrations.length}) can't use (${problem}); update Jefi`,
    )
  }
  console.log(`mail.db schema v${version} is newer than this build (v${migrations.length}) but compatible; using it as is`)
}

type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
type Shape = Map<string, { columns: Column[]; indexes: Set<string> }>

/** A table's indexes by what they enforce and cover, not by name (autoindex names follow column order). */
function indexKeys(db: MailDatabase, table: string): Set<string> {
  const keys = new Set<string>()
  const list = db.query('SELECT name, "unique", partial FROM pragma_index_list(?)').all(table) as { name: string; unique: number; partial: number }[]
  for (const index of list) {
    const cols = db.query('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as { name: string | null }[]
    keys.add(`${index.unique ? 'unique' : 'plain'}${index.partial ? ' partial' : ''} (${cols.map((c) => c.name ?? '<expr>').join(', ')})`)
  }
  return keys
}

function shapeOf(db: MailDatabase): Shape {
  const shape: Shape = new Map()
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  for (const { name } of tables) {
    const columns = db.query('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)').all(name) as Column[]
    shape.set(name, { columns, indexes: indexKeys(db, name) })
  }
  return shape
}

// This build's own schema, built once per migration list by running it on an empty database.
const expectedShapes = new WeakMap<string[], Shape>()
function expectedShape(migrations: string[]): Shape {
  let shape = expectedShapes.get(migrations)
  if (!shape) {
    const scratch = new Database(':memory:', { strict: true })
    try {
      migrate(scratch, migrations)
      shape = shapeOf(scratch)
    } finally {
      scratch.close()
    }
    expectedShapes.set(migrations, shape)
  }
  return shape
}

/**
 * Why a newer mail.db can't be used by this build, or null when it can: it must not ask for a newer
 * reader, and must hold every table, column (same declared type) and index this build has, with any
 * column added to those tables fillable by this build's INSERTs (nullable or defaulted). Triggers
 * aren't compared: the newer build owns how they're written.
 */
export function forwardCompatProblem(db: MailDatabase, migrations = MIGRATIONS): string | null {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_compat'").get()) {
    const row = db.query("SELECT value FROM schema_compat WHERE key = 'min_reader_version'").get() as { value: number } | null
    if (row && Number(row.value) > migrations.length) return `it needs schema v${row.value} or later`
  }
  const actual = shapeOf(db)
  for (const [table, want] of expectedShape(migrations)) {
    const have = actual.get(table)
    if (!have) return `table ${table} is missing`
    const byName = new Map(have.columns.map((c) => [c.name, c]))
    for (const col of want.columns) {
      const found = byName.get(col.name)
      if (!found) return `column ${table}.${col.name} is missing`
      if (found.type.toUpperCase() !== col.type.toUpperCase()) return `column ${table}.${col.name} is ${found.type}, not ${col.type}`
    }
    const known = new Set(want.columns.map((c) => c.name))
    for (const col of have.columns) {
      if (!known.has(col.name) && col.notnull && col.dflt_value === null && !col.pk) return `new column ${table}.${col.name} is required`
    }
    for (const index of want.indexes) if (!have.indexes.has(index)) return `${table} lacks its ${index} index`
  }
  return null
}

/** Rebuilds the search index from the messages and bodies tables, for an index that drifted or was damaged. */
export function rebuildSearchIndex(db: MailDatabase): number {
  db.transaction(() => {
    db.exec('DELETE FROM message_search')
    db.exec(`
      INSERT INTO message_search (rowid, subject, sender, recipients, body)
        SELECT m.id, m.subject, COALESCE(m.from_name, '') || ' ' || COALESCE(m.from_email, ''), m.to_json || ' ' || m.cc_json, COALESCE(b.text, '')
          FROM messages m LEFT JOIN bodies b ON b.message_id = m.id
    `)
  })()
  return (db.query('SELECT count(*) c FROM message_search').get() as { c: number }).c
}
