import type { MailDatabase } from '../db'
import { threadMessageIds, uiThreadId } from '../threading'
import type { Link, LinkSnapshot, LinkTarget, MailLinkTarget } from './types'

// ---------------------------------------------------------------------------
// Links from notes and events to mail, events and people, shared by note_links and event_links.
// A mail link stores the UI id it was made with plus the Message-ID header, and a snapshot taken
// from the database at link time. Reading one re-finds the mail by header when the UI id went stale
// (re-threading, a resync), so the link follows the message rather than the id.
// ---------------------------------------------------------------------------

export type LinkRow = {
  id: string
  kind: LinkTarget['kind']
  account_id: string | null
  target_ref: string | null
  message_id_header: string | null
  snapshot_json: string
  created_at: number
}

type MessageRow = { id: number; thread_id: string | null; subject: string; from_name: string | null; from_email: string | null; date: number; message_id: string | null }
const MESSAGE_COLUMNS = 'id, thread_id, subject, from_name, from_email, date, message_id'

const messageRowId = (messageId: string) => {
  const match = messageId.match(/-(\d+)$/)
  return match ? Number(match[1]) : null
}

const snapshotOf = (row: MessageRow, latest = row.date): LinkSnapshot => ({
  subject: row.subject,
  ...(row.from_email ? { from: { ...(row.from_name ? { name: row.from_name } : {}), email: row.from_email } } : {}),
  date: latest,
})

/** Messages of a UI thread, oldest first. */
function threadRows(db: MailDatabase, accountId: string, threadId: string): MessageRow[] {
  const ids = threadMessageIds(db, accountId, threadId)
  if (!ids.length) return []
  return db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE account_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY date, id`).all(accountId, JSON.stringify(ids)) as MessageRow[]
}

const messageRow = (db: MailDatabase, accountId: string, messageId: string) => {
  const rowId = messageRowId(messageId)
  return rowId === null ? null : (db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND account_id = ?`).get(rowId, accountId) as MessageRow | null)
}

const byHeader = (db: MailDatabase, accountId: string, header: string) =>
  db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE account_id = ? AND message_id = ? ORDER BY id LIMIT 1`).get(accountId, header) as MessageRow | null

/** The Message-ID headers of a UI thread's messages, to find links made to any of them. */
export function threadHeaders(db: MailDatabase, accountId: string, threadId: string): string[] {
  return threadRows(db, accountId, threadId).flatMap((r) => (r.message_id ? [r.message_id] : []))
}

/**
 * The columns to store for a link to mail, with a snapshot from the database (falling back to
 * `given` for anything it lacks). Throws if the mail isn't stored.
 */
export function mailLinkColumns(db: MailDatabase, target: MailLinkTarget, given: LinkSnapshot = {}) {
  if (target.kind === 'thread') {
    const rows = threadRows(db, target.accountId, target.threadId)
    if (!rows.length) throw new Error('Conversation not found')
    const root = rows[0]!
    return { accountId: target.accountId, ref: target.threadId, header: root.message_id, snapshot: { ...given, ...snapshotOf(root, rows.at(-1)!.date) } }
  }
  const row = messageRow(db, target.accountId, target.messageId)
  if (!row) throw new Error('Message not found')
  return { accountId: target.accountId, ref: target.messageId, header: row.message_id, snapshot: { ...given, ...snapshotOf(row) } }
}

/** A stored link as the UI sees it: its current target (re-found by header if need be) and whether it's live. */
export function linkOf(db: MailDatabase, row: LinkRow): Link {
  const snapshot = JSON.parse(row.snapshot_json) as LinkSnapshot
  const base = { id: row.id, snapshot, createdAt: row.created_at }
  if (row.kind === 'event') {
    const live = !!db.query('SELECT 1 FROM events WHERE id = ?').get(row.target_ref)
    return { ...base, target: { kind: 'event', eventId: row.target_ref ?? '' }, live }
  }
  if (row.kind === 'contact') return { ...base, target: { kind: 'contact', email: row.target_ref ?? '', ...(snapshot.name ? { name: snapshot.name } : {}) }, live: true }
  if (row.account_id === null || row.target_ref === null) return { ...base, target: { kind: row.kind, accountId: null }, live: false }
  const accountId = row.account_id
  if (row.kind === 'thread') {
    if (threadMessageIds(db, accountId, row.target_ref).length) return { ...base, target: { kind: 'thread', accountId, threadId: row.target_ref }, live: true }
    const moved = row.message_id_header ? byHeader(db, accountId, row.message_id_header) : null
    const threadId = moved ? uiThreadId(accountId, moved.thread_id, moved.id) : row.target_ref
    return { ...base, target: { kind: 'thread', accountId, threadId }, live: !!moved }
  }
  // The message's UI id carries its thread's, which re-threading changes: rebuild it from the row.
  const found = messageRow(db, accountId, row.target_ref) ?? (row.message_id_header ? byHeader(db, accountId, row.message_id_header) : null)
  const messageId = found ? `${uiThreadId(accountId, found.thread_id, found.id)}-${found.id}` : row.target_ref
  return { ...base, target: { kind: 'message', accountId, messageId }, live: !!found }
}

/**
 * SQL (for a link table aliased `l`) matching links to a UI thread: to the thread itself, or to any
 * of its messages, by UI id or by header.
 */
export const THREAD_MATCH = `l.kind IN ('thread', 'message') AND l.account_id = ? AND (
    (l.kind = 'thread' AND l.target_ref = ?)
    OR (l.kind = 'message' AND substr(l.target_ref, 1, length(?) + 1) = ? || '-')
    OR l.message_id_header IN (SELECT value FROM json_each(?)))`

export const threadMatchArgs = (db: MailDatabase, accountId: string, threadId: string) =>
  [accountId, threadId, threadId, threadId, JSON.stringify(threadHeaders(db, accountId, threadId))] as const

/**
 * Removing an account: notes, events and tasks stay (they belong to no account), but their links keep only
 * their kind and snapshot, and events forget the account as the identity they answer invites as.
 * Runs inside deleteAccountData's transaction.
 */
export function detachAccount(db: MailDatabase, accountId: string) {
  for (const table of ['note_links', 'event_links', 'task_links']) {
    db.run(`UPDATE ${table} SET account_id = NULL, target_ref = NULL, message_id_header = NULL WHERE account_id = ?`, [accountId])
  }
  db.run('UPDATE events SET account_id = NULL WHERE account_id = ?', [accountId])
}
