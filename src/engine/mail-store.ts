import { deferConversations, type MailDatabase } from './db'
import { detachAccount } from './calendar/links'
import { storeInvites, type StoredInvite } from './calendar/store'
import { findSignIn } from '../sign-in-code'

// ---------------------------------------------------------------------------
// Reads and writes for synced mail. Everything here is synchronous bun:sqlite and runs inside the
// engine worker; batch writes are transactional so a crash never leaves a half-applied batch or a
// checkpoint ahead of the messages it claims to cover.
// ---------------------------------------------------------------------------

export type Address = { name?: string; email: string }

export type MailboxRow = {
  id: number
  account_id: string
  path: string
  delimiter: string | null
  special_use: string | null
  uidvalidity: number | null
  uidnext: number | null
  highestmodseq: number | null
  last_uid: number
  synced_at: number | null
  /** Message count when the last sync finished; NULL after a partial one. */
  exists_count: number | null
}

export type DiscoveredMailbox = { path: string; delimiter?: string | null; specialUse?: string | null }

export type SyncedMessage = {
  uid: number
  modseq?: number | null
  messageId?: string | null
  gmMsgId?: string | null
  subject: string
  from?: Address | null
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  inReplyTo?: string | null
  references: string[]
  date: number
  size?: number | null
  flags: string[]
  /** Gmail X-GM-LABELS, when the server has X-GM-EXT-1. System labels (\\Inbox, \\Sent…) are dropped. */
  labels?: string[]
  /** List-Unsubscribe (RFC 2369): the raw `<https://…>, <mailto:…>` value. */
  listUnsubscribe?: string | null
  /** List-Unsubscribe-Post: One-Click (RFC 8058) — unsubscribing is a single POST. */
  listUnsubscribePost?: boolean
}

/** `exists` marks a folder fully caught up; any checkpoint without it (a mid-sync batch) clears it. */
export type Checkpoint = { lastUid: number; uidnext?: number | null; highestmodseq?: number | null; exists?: number | null }

export type StoredBody = {
  text: string | null
  html: string | null
  snippet: string
  attachments: Array<{ filename?: string | null; contentType?: string | null; contentId?: string | null; size?: number | null; sizeEstimated?: boolean; part?: string | null }>
  /** text/calendar parts, raw (calendar/store invites). */
  invites?: StoredInvite[]
}

const SYSTEM_FLAGS = new Set(['\\seen', '\\flagged', '\\answered', '\\draft', '\\deleted', '\\recent'])

export function ensureAccount(db: MailDatabase, id: string, email: string) {
  db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email', [id, email, Date.now()])
}

/** Every account with a row in the database, including ones no longer in accounts.json. */
export function storedAccountIds(db: MailDatabase): string[] {
  return (db.query('SELECT id FROM accounts').all() as Array<{ id: string }>).map((r) => r.id)
}

/**
 * Deletes an account and everything stored for it, in one transaction. Every table cascades from
 * `accounts`, but only while foreign_keys is on for this connection, so each is also cleared by
 * name: removal must not depend on a pragma. Search rows go first, so the triggers on bodies and
 * messages find nothing left to rewrite. Freed pages stay in the file (auto_vacuum is off) and are
 * reused by later mail; only a VACUUM shrinks it.
 */
export function deleteAccountData(db: MailDatabase, accountId: string) {
  const ofMessages = 'message_id IN (SELECT id FROM messages WHERE account_id = ?)'
  db.transaction(() => {
    db.run('DELETE FROM message_search WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)', [accountId])
    for (const table of ['bodies', 'attachments', 'invites', 'invite_state', 'message_labels', 'message_mailboxes', 'mailbox_aliases']) db.run(`DELETE FROM ${table} WHERE ${ofMessages}`, [accountId])
    detachAccount(db, accountId)
    for (const table of ['message_mailboxes', 'mailbox_aliases']) db.run(`DELETE FROM ${table} WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id = ?)`, [accountId])
    for (const table of ['messages', 'mailboxes', 'pending_ops', 'outbound_queue', 'drafts', 'draft_removals', 'rules', 'screener', 'sender_verdicts', 'snoozes', 'list_removals', 'conversations', 'local_label_links', 'local_labels']) {
      db.run(`DELETE FROM ${table} WHERE account_id = ?`, [accountId])
    }
    db.run('DELETE FROM accounts WHERE id = ?', [accountId])
  })()
}

export function listMailboxes(db: MailDatabase, accountId: string): MailboxRow[] {
  return db.query('SELECT * FROM mailboxes WHERE account_id = ? ORDER BY path').all(accountId) as MailboxRow[]
}

/**
 * Mirror the server's folder list: add new folders, refresh attributes, and drop folders that are
 * gone (their message links cascade; messages left in no folder are removed).
 */
export function saveMailboxes(db: MailDatabase, accountId: string, discovered: DiscoveredMailbox[]): MailboxRow[] {
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO mailboxes (account_id, path, delimiter, special_use) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, path) DO UPDATE SET delimiter = excluded.delimiter, special_use = excluded.special_use`,
    )
    for (const box of discovered) upsert.run(accountId, box.path, box.delimiter ?? null, box.specialUse ?? null)
    const keep = new Set(discovered.map((b) => b.path))
    for (const existing of listMailboxes(db, accountId)) {
      if (!keep.has(existing.path)) db.run('DELETE FROM mailboxes WHERE id = ?', [existing.id])
    }
    deleteOrphanMessages(db, accountId)
  })()
  return listMailboxes(db, accountId)
}

/** UIDVALIDITY changed: every cached UID for this mailbox is meaningless, so start it over. */
export function resetMailbox(db: MailDatabase, mailboxId: number, uidvalidity: number) {
  db.transaction(() => {
    const row = db.query('SELECT account_id FROM mailboxes WHERE id = ?').get(mailboxId) as { account_id: string } | null
    db.run('DELETE FROM message_mailboxes WHERE mailbox_id = ?', [mailboxId])
    db.run('DELETE FROM mailbox_aliases WHERE mailbox_id = ?', [mailboxId])
    db.run('UPDATE mailboxes SET uidvalidity = ?, uidnext = NULL, highestmodseq = NULL, last_uid = 0, synced_at = NULL, exists_count = NULL WHERE id = ?', [uidvalidity, mailboxId])
    if (row) deleteOrphanMessages(db, row.account_id)
  })()
}

export function deleteOrphanMessages(db: MailDatabase, accountId: string) {
  db.run(
    `DELETE FROM messages WHERE account_id = ?
       AND NOT EXISTS (SELECT 1 FROM message_mailboxes mm WHERE mm.message_id = messages.id)`,
    [accountId],
  )
}

export function setCheckpoint(db: MailDatabase, mailboxId: number, uidvalidity: number, checkpoint: Checkpoint) {
  db.run(
    `UPDATE mailboxes SET uidvalidity = ?, last_uid = MAX(last_uid, ?), uidnext = COALESCE(?, uidnext),
       highestmodseq = COALESCE(?, highestmodseq), exists_count = ?, synced_at = ? WHERE id = ?`,
    [uidvalidity, checkpoint.lastUid, checkpoint.uidnext ?? null, checkpoint.highestmodseq ?? null, checkpoint.exists ?? null, Date.now(), mailboxId],
  )
}

/**
 * Store one fetched batch and advance the mailbox checkpoint in the same transaction. A message
 * already known (same Gmail X-GM-MSGID, or same Message-ID) is linked rather than duplicated.
 */
export type StoreResult = { stored: number; skipped: Array<{ uid: number; error: string }> }

export function storeBatch(db: MailDatabase, accountId: string, mailbox: { id: number; uidvalidity: number }, messages: SyncedMessage[], checkpoint: Checkpoint): StoreResult {
  const byGmId = db.prepare('SELECT id FROM messages WHERE account_id = ? AND gm_msgid = ?')
  const byMessageId = db.prepare('SELECT id FROM messages WHERE account_id = ? AND message_id = ? ORDER BY id LIMIT 1')
  const insert = db.prepare(
    `INSERT INTO messages (account_id, message_id, gm_msgid, subject, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
       in_reply_to, references_json, date, size, seen, flagged, answered, draft, keywords_json, list_unsubscribe, list_unsubscribe_post)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
  const updateFlags = db.prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ?, draft = ?, keywords_json = ? WHERE id = ?')
  const saveUnsubscribe = db.prepare('UPDATE messages SET list_unsubscribe = ?, list_unsubscribe_post = ? WHERE id = ? AND list_unsubscribe IS NULL')
  /**
   * A folder can hold several copies of the same message (duplicate delivery, a message sent to
   * yourself, a list that also mails you directly), and a local move leaves a placeholder UID.
   * One row per message per folder. A placeholder (uid <= 0) is replaced by the real UID; a second
   * real UID becomes an alias (lume-6fz), so sync still counts it as on the server and known.
   */
  const dropPlaceholders = db.prepare('DELETE FROM message_mailboxes WHERE message_id = ? AND mailbox_id = ? AND uid <= 0')
  const otherCopy = db.prepare('SELECT uid FROM message_mailboxes WHERE message_id = ? AND mailbox_id = ? AND uid > 0 AND uid <> ?')
  const alias = db.prepare('INSERT INTO mailbox_aliases (mailbox_id, uid, message_id) VALUES (?, ?, ?) ON CONFLICT (mailbox_id, uid) DO UPDATE SET message_id = excluded.message_id')
  const unalias = db.prepare('DELETE FROM mailbox_aliases WHERE mailbox_id = ? AND uid = ?')
  const link = db.prepare(
    `INSERT INTO message_mailboxes (mailbox_id, uid, message_id, modseq) VALUES (?, ?, ?, ?)
     ON CONFLICT (mailbox_id, uid) DO UPDATE SET message_id = excluded.message_id, modseq = excluded.modseq`,
  )

  // Once per batch, not per message: each lookup parses every queued op.
  const pendingLabels = messages.some((m) => m.labels) ? messagesWithPendingOps(db, accountId, 'labels') : new Set<number>()
  const result: StoreResult = { stored: 0, skipped: [] }
  // Each message's conversation is rebuilt once at the end of the batch, not on every insert and link.
  deferConversations(db, () => {
    for (const m of messages) {
      try {
        store(m)
        result.stored++
      } catch (err) {
        // One unusual message must not abort a whole mailbox; record it and carry on.
        result.skipped.push({ uid: m.uid, error: err instanceof Error ? err.message : String(err) })
      }
    }
    setCheckpoint(db, mailbox.id, mailbox.uidvalidity, checkpoint)
  })
  return result

  function store(m: SyncedMessage) {
      const flags = new Set(m.flags.map((f) => f.toLowerCase()))
      const keywords = JSON.stringify(m.flags.filter((f) => !SYSTEM_FLAGS.has(f.toLowerCase())))
      const flagValues = [flags.has('\\seen') ? 1 : 0, flags.has('\\flagged') ? 1 : 0, flags.has('\\answered') ? 1 : 0, flags.has('\\draft') ? 1 : 0] as const

      const existing =
        (m.gmMsgId ? (byGmId.get(accountId, m.gmMsgId) as { id: number } | null) : null) ??
        (m.messageId ? (byMessageId.get(accountId, m.messageId) as { id: number } | null) : null)

      let id: number
      if (existing) {
        id = existing.id
        updateFlags.run(...flagValues, keywords, id)
        if (m.listUnsubscribe) saveUnsubscribe.run(m.listUnsubscribe, m.listUnsubscribePost ? 1 : 0, id)
      } else {
        const row = insert.get(
          accountId,
          m.messageId ?? null,
          m.gmMsgId ?? null,
          m.subject,
          m.from?.name ?? null,
          m.from?.email ?? null,
          JSON.stringify(m.to),
          JSON.stringify(m.cc),
          JSON.stringify(m.bcc),
          JSON.stringify(m.replyTo),
          m.inReplyTo ?? null,
          JSON.stringify(m.references),
          m.date,
          m.size ?? null,
          ...flagValues,
          keywords,
          m.listUnsubscribe ?? null,
          m.listUnsubscribePost ? 1 : 0,
        ) as { id: number }
        id = row.id
      }
      if (m.labels && !pendingLabels.has(id)) setMessageLabels(db, accountId, id, m.labels, { force: true })
      dropPlaceholders.run(id, mailbox.id)
      if (otherCopy.get(id, mailbox.id, m.uid)) {
        alias.run(mailbox.id, m.uid, id)
        return
      }
      unalias.run(mailbox.id, m.uid)
      link.run(mailbox.id, m.uid, id, m.modseq ?? null)
  }
}

export const userLabels = (labels: Iterable<string>) => [...labels].filter((l) => !l.startsWith('\\'))

/**
 * Replace a message's Gmail labels, unless a local label change for it is still queued (`force`: the
 * caller has checked). Returns whether they changed.
 */
export function setMessageLabels(db: MailDatabase, accountId: string, messageId: number, labels: string[], options: { force?: boolean } = {}): boolean {
  if (!options.force && messagesWithPendingOps(db, accountId, 'labels').has(messageId)) return false
  // Already these labels (every sync of a second Gmail folder, most flag refreshes): rewriting them
  // would only fire the list-revision triggers for a change nobody can see.
  const next = new Set(userLabels(labels))
  const current = labelsOf(db, messageId)
  if (current.length === next.size && current.every((label) => next.has(label))) return false
  db.run('DELETE FROM message_labels WHERE message_id = ?', [messageId])
  const add = db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label) VALUES (?, ?)')
  for (const label of next) add.run(messageId, label)
  return true
}

export function labelsOf(db: MailDatabase, messageId: number): string[] {
  return (db.query('SELECT label FROM message_labels WHERE message_id = ? ORDER BY label').all(messageId) as Array<{ label: string }>).map((r) => r.label)
}

/** Messages with local changes still queued for the server; syncs must not overwrite them. */
export function messagesWithPendingOps(db: MailDatabase, accountId: string, kind?: string): Set<number> {
  const rows = (
    kind
      ? db.query('SELECT payload_json FROM pending_ops WHERE account_id = ? AND kind = ?').all(accountId, kind)
      : db.query('SELECT payload_json FROM pending_ops WHERE account_id = ?').all(accountId)
  ) as Array<{ payload_json: string }>
  return new Set(rows.map((r) => (JSON.parse(r.payload_json) as { messageId: number }).messageId))
}

/** Server messages this folder holds: links (placeholders of a queued move have negative UIDs) plus duplicate-copy aliases. */
export const linkedCount = (db: MailDatabase, mailboxId: number) =>
  (db.query('SELECT (SELECT count(*) FROM message_mailboxes WHERE mailbox_id = ?1 AND uid > 0) + (SELECT count(*) FROM mailbox_aliases WHERE mailbox_id = ?1) n').get(mailboxId) as { n: number }).n

/** Server-side UIDs this mailbox has synced, aliases of duplicate copies included (placeholders from local moves excluded). */
export function knownUids(db: MailDatabase, mailboxId: number, upTo: number): Array<{ uid: number; message_id: number }> {
  return db
    .query('SELECT uid, message_id FROM message_mailboxes WHERE mailbox_id = ?1 AND uid > 0 AND uid <= ?2 UNION ALL SELECT uid, message_id FROM mailbox_aliases WHERE mailbox_id = ?1 AND uid <= ?2')
    .all(mailboxId, upTo) as Array<{ uid: number; message_id: number }>
}

/**
 * Drop links for UIDs the server no longer has. Messages left without any folder are removed at the
 * end of a full sync, not here, so a message moved to a folder synced later keeps its row and body.
 * A gone alias just goes; a gone link whose message still has an alias here is moved onto that
 * alias's UID instead, since the message is still in the folder (lume-6fz).
 */
export function removeLinks(db: MailDatabase, mailboxId: number, uids: number[]) {
  if (uids.length === 0) return
  db.transaction(() => {
    const unalias = db.prepare('DELETE FROM mailbox_aliases WHERE mailbox_id = ? AND uid = ?')
    for (const uid of uids) unalias.run(mailboxId, uid)
    const linked = db.prepare('SELECT message_id FROM message_mailboxes WHERE mailbox_id = ? AND uid = ?')
    const survivor = db.prepare('SELECT uid FROM mailbox_aliases WHERE mailbox_id = ? AND message_id = ? ORDER BY uid DESC LIMIT 1')
    const promote = db.prepare('UPDATE message_mailboxes SET uid = ?, modseq = NULL WHERE mailbox_id = ? AND uid = ?')
    const remove = db.prepare('DELETE FROM message_mailboxes WHERE mailbox_id = ? AND uid = ?')
    for (const uid of uids) {
      const row = linked.get(mailboxId, uid) as { message_id: number } | null
      const next = row && (survivor.get(mailboxId, row.message_id) as { uid: number } | null)
      if (next) {
        unalias.run(mailboxId, next.uid)
        promote.run(next.uid, mailboxId, uid)
      } else remove.run(mailboxId, uid)
    }
  })()
}

/**
 * Apply flags (and Gmail labels, when given) read back from the server to messages already stored.
 * Messages with queued local changes are skipped. UIDs of duplicate-copy aliases match no link and
 * are ignored: the linked copy's flags win. Returns how many messages changed.
 */
export function updateFlags(db: MailDatabase, accountId: string, mailboxId: number, updates: Array<{ uid: number; flags: string[]; labels?: string[] }>): number {
  if (updates.length === 0) return 0
  const pending = messagesWithPendingOps(db, accountId)
  const byUid = db.prepare('SELECT message_id FROM message_mailboxes WHERE mailbox_id = ? AND uid = ?')
  const update = db.prepare(
    `UPDATE messages SET seen = ?, flagged = ?, answered = ?, draft = ?, keywords_json = ?
      WHERE id = ? AND (seen, flagged, answered, draft, keywords_json) IS NOT (?, ?, ?, ?, ?)`,
  )
  let changed = 0
  db.transaction(() => {
    for (const { uid, flags, labels } of updates) {
      const row = byUid.get(mailboxId, uid) as { message_id: number } | null
      if (!row) continue
      // `pending` holds every queued op's message, label changes included.
      if (labels && !pending.has(row.message_id) && setMessageLabels(db, accountId, row.message_id, labels, { force: true })) changed++
      if (pending.has(row.message_id)) continue
      const set = new Set(flags.map((f) => f.toLowerCase()))
      const values = [set.has('\\seen') ? 1 : 0, set.has('\\flagged') ? 1 : 0, set.has('\\answered') ? 1 : 0, set.has('\\draft') ? 1 : 0, JSON.stringify(flags.filter((f) => !SYSTEM_FLAGS.has(f.toLowerCase())))] as const
      // Not `changes` itself: bun counts rows the list-revision triggers touch as well.
      if (update.run(...values, row.message_id, ...values).changes > 0) changed++
    }
  })()
  return changed
}

/** Messages that still need their body downloaded, newest first, with a UID to fetch each by. */
export function messagesMissingBodies(db: MailDatabase, accountId: string, limit: number, threadKey: string | null = null) {
  return db
    .query(
      `SELECT m.id, mb.path, mm.uid, m.size FROM messages m
         JOIN message_mailboxes mm ON mm.message_id = m.id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
       WHERE m.account_id = ?1 AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)
         AND (?3 IS NULL OR COALESCE(m.thread_id, 'm' || m.id) = ?3)
       GROUP BY m.id ORDER BY m.date DESC LIMIT ?2`,
    )
    .all(accountId, limit, threadKey) as Array<{ id: number; path: string; uid: number; size: number | null }>
}

/** Which of `ids` still have no stored body: a fetch that came back short left these behind. */
export function bodilessIds(db: MailDatabase, ids: number[]): number[] {
  if (!ids.length) return []
  return (
    db.query(`SELECT m.id FROM messages m WHERE m.id IN (${ids.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)`).all(...ids) as Array<{ id: number }>
  ).map((row) => row.id)
}

/** Messages in one mailbox past `afterUid` that still need a body — the push-sync fast path only
 * wants bodies for mail that just arrived, not a whole account's backlog. */
export function messagesMissingBodiesInMailbox(db: MailDatabase, mailboxId: number, afterUid: number) {
  return db
    .query(
      `SELECT m.id, mb.path, mm.uid, m.size FROM messages m
         JOIN message_mailboxes mm ON mm.message_id = m.id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
       WHERE mm.mailbox_id = ? AND mm.uid > ? AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)`,
    )
    .all(mailboxId, afterUid) as Array<{ id: number; path: string; uid: number; size: number | null }>
}

// --- Drafts ------------------------------------------------------------------------------------

export type DraftRow = { id: string; mail_json: string; updated_at: number }

export function saveDraftRow(db: MailDatabase, accountId: string, id: string, mail: unknown) {
  // Saving it unchanged (Save draft again, a reopened draft closed as it was) leaves it alone: a new
  // revision would push the whole message, attachments and all, to the server Drafts again.
  db.run(
    `INSERT INTO drafts (id, account_id, mail_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET mail_json = excluded.mail_json, updated_at = excluded.updated_at
       WHERE drafts.mail_json IS NOT excluded.mail_json`,
    [id, accountId, JSON.stringify(mail), Date.now()],
  )
}

/** The account a draft is saved under, or null when there is no such draft. */
export const draftAccountOf = (db: MailDatabase, id: string): string | null =>
  (db.query('SELECT account_id FROM drafts WHERE id = ?').get(id) as { account_id: string } | null)?.account_id ?? null

/** Deletes a draft (sent or discarded); its copy on the server, if it has one, is queued for removal. */
export function deleteDraftRow(db: MailDatabase, id: string): boolean {
  return db.transaction(() => {
    db.run(
      `INSERT OR IGNORE INTO draft_removals (account_id, message_id)
       SELECT account_id, remote_message_id FROM drafts WHERE id = ? AND remote_message_id IS NOT NULL`,
      [id],
    )
    return db.run('DELETE FROM drafts WHERE id = ?', [id]).changes > 0
  })()
}

// Remote Drafts: best effort, after the local save. A draft is pushed when it changed since its last
// push; the Message-ID is fixed before the first APPEND so even a copy whose APPEND reply was lost is
// recognised (hidden from the list, replaced next time).

export type DirtyDraft = DraftRow & { remote_message_id: string | null }

export const dirtyDrafts = (db: MailDatabase, accountId: string): DirtyDraft[] =>
  db
    .query('SELECT id, mail_json, updated_at, remote_message_id FROM drafts WHERE account_id = ? AND (remote_synced_at IS NULL OR remote_synced_at < updated_at)')
    .all(accountId) as DirtyDraft[]

/** The draft's Message-ID on the server, assigning `fresh` the first time. */
export function draftMessageId(db: MailDatabase, id: string, fresh: string): string {
  db.run('UPDATE drafts SET remote_message_id = ? WHERE id = ? AND remote_message_id IS NULL', [fresh, id])
  return (db.query('SELECT remote_message_id FROM drafts WHERE id = ?').get(id) as { remote_message_id: string | null } | null)?.remote_message_id ?? fresh
}

/** Records the revision that reached the server; a later edit (newer updated_at) makes it dirty again. */
export const markDraftPushed = (db: MailDatabase, id: string, revision: number) => db.run('UPDATE drafts SET remote_synced_at = ? WHERE id = ?', [revision, id])

export const draftRemovals = (db: MailDatabase, accountId: string): string[] =>
  (db.query('SELECT message_id FROM draft_removals WHERE account_id = ?').all(accountId) as Array<{ message_id: string }>).map((r) => r.message_id)

export const clearDraftRemoval = (db: MailDatabase, accountId: string, messageId: string) =>
  db.run('DELETE FROM draft_removals WHERE account_id = ? AND message_id = ?', [accountId, messageId])

export const listDrafts = (db: MailDatabase, accountId: string): DraftRow[] =>
  db.query('SELECT id, mail_json, updated_at FROM drafts WHERE account_id = ? ORDER BY updated_at DESC').all(accountId) as DraftRow[]

// A calendar part that is the message's invitation shows as the reader's invite card, not a file:
// one without a filename (the text/calendar alternative of an iMIP mail), or any once the message has
// an iTIP invite stored (what calendar/invites.ts's itipOf shows a card for). A named .ics in a
// message without one, a PUBLISH export say, stays a file. Applied when reading, so mail synced
// before this rule reads the same without a migration. `a` is the attachments row.
export const INVITE_PART_SQL = `(lower(coalesce(a.content_type, '')) IN ('text/calendar', 'application/ics')
  AND (coalesce(a.filename, '') = '' OR EXISTS (SELECT 1 FROM invites i WHERE i.message_id = a.message_id AND upper(i.method) IN ('REQUEST', 'CANCEL', 'REPLY'))))`
/** Whether message `m` has an attachment the reader lists. */
export const HAS_ATTACHMENTS_SQL = `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND NOT ${INVITE_PART_SQL})`

export function storeBody(db: MailDatabase, messageId: number, body: StoredBody) {
  db.transaction(() => {
    db.run('INSERT OR REPLACE INTO bodies (message_id, text, html, fetched_at) VALUES (?, ?, ?, ?)', [messageId, body.text, body.html, Date.now()])
    db.run('DELETE FROM attachments WHERE message_id = ?', [messageId])
    const add = db.prepare('INSERT INTO attachments (message_id, part, filename, content_type, content_id, size, size_estimated) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const a of body.attachments) add.run(messageId, a.part ?? null, a.filename ?? null, a.contentType ?? null, a.contentId ?? null, a.size ?? null, a.sizeEstimated ? 1 : 0)
    storeInvites(db, messageId, body.invites ?? [])
    // The sign-in code or link, found once here so the list can offer it without loading bodies.
    const subject = (db.query('SELECT subject FROM messages WHERE id = ?').get(messageId) as { subject: string } | null)?.subject ?? ''
    const signIn = findSignIn({ subject, text: body.text, html: body.html })
    db.run(`UPDATE messages AS m SET snippet = ?, sign_in = ?, has_attachments = ${HAS_ATTACHMENTS_SQL} WHERE id = ?`, [body.snippet, signIn ? JSON.stringify(signIn) : null, messageId])
  })()
}
