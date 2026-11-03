import type { FolderId } from '../data'
import type { MailDatabase } from './db'
import { HAS_ATTACHMENTS_SQL } from './mail-store'
import { gmailLabelId, queueFlags, queueLabels, queueMove } from './pending-ops'
import { isLocalLabelOf, setThreadLocalLabels, threadLocalLabels } from './local-labels'
import { assignThreads, uiThreadId } from './threading'

// ---------------------------------------------------------------------------
// Mail rules: "when a message matches, do these things". The engine applies enabled rules to new
// Inbox mail right after each sync (before new mail is announced), and to existing mail on demand.
// Actions go through the ordinary queued operations, so they reach the server like manual ones.
// ---------------------------------------------------------------------------

export type RuleMatch = {
  /** Sender address or name contains. */
  from?: string
  /** Any recipient (To or Cc) contains. */
  to?: string
  subject?: string
  /** Sent through a mailing list (has List-Unsubscribe). */
  list?: boolean
  hasAttachment?: boolean
}

export type RuleActions = {
  moveTo?: Extract<FolderId, 'archive' | 'trash' | 'spam' | 'inbox'>
  /** A Gmail label id (see gmailLabelId), or one of Jefi's own (see localLabelId). */
  label?: string
  markRead?: boolean
  star?: boolean
}

export type MailRule = { id: string; name: string; enabled: boolean; match: RuleMatch; actions: RuleActions }

export function listRules(db: MailDatabase, accountId: string): MailRule[] {
  return (db.query('SELECT rule_json FROM rules WHERE account_id = ? ORDER BY position, id').all(accountId) as Array<{ rule_json: string }>).map((r) => JSON.parse(r.rule_json) as MailRule)
}

export function saveRule(db: MailDatabase, accountId: string, rule: MailRule) {
  const position = (db.query('SELECT COALESCE(max(position), 0) + 1 AS p FROM rules WHERE account_id = ?').get(accountId) as { p: number }).p
  db.run(
    `INSERT INTO rules (id, account_id, position, rule_json) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET rule_json = excluded.rule_json`,
    [rule.id, accountId, position, JSON.stringify(rule)],
  )
}

export const deleteRule = (db: MailDatabase, accountId: string, id: string) => void db.run('DELETE FROM rules WHERE account_id = ? AND id = ?', [accountId, id])

/** True when a rule would match everything: refuse those rather than archive a whole mailbox. */
export const isEmptyMatch = (match: RuleMatch) => !match.from?.trim() && !match.to?.trim() && !match.subject?.trim() && !match.list && !match.hasAttachment

function whereFor(match: RuleMatch): { sql: string; args: Array<string | number> } {
  const parts: string[] = []
  const args: Array<string | number> = []
  const like = (value: string) => `%${value.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  if (match.from?.trim()) {
    parts.push("(lower(COALESCE(m.from_email, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(m.from_name, '')) LIKE ? ESCAPE '\\')")
    args.push(like(match.from), like(match.from))
  }
  if (match.to?.trim()) {
    parts.push("(lower(m.to_json) LIKE ? ESCAPE '\\' OR lower(m.cc_json) LIKE ? ESCAPE '\\')")
    args.push(like(match.to), like(match.to))
  }
  if (match.subject?.trim()) {
    parts.push("lower(m.subject) LIKE ? ESCAPE '\\'")
    args.push(like(match.subject))
  }
  if (match.list) parts.push('m.list_unsubscribe IS NOT NULL')
  if (match.hasAttachment) parts.push(HAS_ATTACHMENTS_SQL)
  return { sql: parts.join(' AND '), args }
}

/**
 * Applies `rules` to the given messages (or, with `messageIds` null, to all mail in the Inbox).
 * Returns how many conversations each rule touched.
 */
export function applyRules(db: MailDatabase, accountId: string, rules: MailRule[], messageIds: number[] | null): Map<string, number> {
  const touched = new Map<string, number>()
  if (messageIds && messageIds.length === 0) return touched
  assignThreads(db, accountId)
  const scope = messageIds
    ? `m.id IN (${messageIds.map(() => '?').join(',')})`
    : `EXISTS (SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = m.id AND mb.special_use = '\\Inbox')`
  const handled = new Set<string>()
  for (const rule of rules) {
    if (!rule.enabled || isEmptyMatch(rule.match)) continue
    const where = whereFor(rule.match)
    const rows = db
      .query(`SELECT m.id, m.thread_id FROM messages m WHERE m.account_id = ? AND ${scope} AND ${where.sql}`)
      .all(accountId, ...(messageIds ?? []), ...where.args) as Array<{ id: number; thread_id: string | null }>
    const threads = [...new Set(rows.map((r) => uiThreadId(accountId, r.thread_id, r.id)))]
    for (const threadId of threads) {
      // First matching rule that moves a conversation wins; flags and labels still stack.
      const { moveTo, label, markRead, star } = rule.actions
      if (markRead || star) queueFlags(db, accountId, threadId, { ...(markRead ? { unread: false } : {}), ...(star ? { starred: true } : {}) })
      if (label && isLocalLabelOf(accountId, label)) setThreadLocalLabels(db, accountId, threadId, [...threadLocalLabels(db, accountId, threadId), label])
      else if (label) {
        const current = db
          .query(`SELECT DISTINCT label FROM message_labels WHERE message_id IN (SELECT m.id FROM messages m WHERE m.account_id = ? AND COALESCE(m.thread_id, 'm' || m.id) = ?)`)
          .all(accountId, threadId.slice(accountId.length + 1)) as Array<{ label: string }>
        const ids = new Set(current.map((c) => gmailLabelId(accountId, c.label)))
        if (!ids.has(label)) queueLabels(db, accountId, threadId, [...ids, label])
      }
      if (moveTo && !handled.has(threadId)) {
        queueMove(db, accountId, threadId, moveTo)
        handled.add(threadId)
      }
    }
    if (threads.length) touched.set(rule.id, threads.length)
  }
  return touched
}

/** Messages that arrived in the Inbox since `lastUid` (the Inbox's high-water mark before a sync). */
export function newInboxMessageIds(db: MailDatabase, inboxId: number, lastUid: number): number[] {
  return (db.query('SELECT message_id FROM message_mailboxes WHERE mailbox_id = ? AND uid > ?').all(inboxId, lastUid) as Array<{ message_id: number }>).map((r) => r.message_id)
}
