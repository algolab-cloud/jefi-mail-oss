import type { MailDatabase } from './db'
import { HAS_ATTACHMENTS_SQL } from './mail-store'
import { loadThreads, type ThreadOptions } from './threads'
import type { MailThread } from '../data'

// ---------------------------------------------------------------------------
// Search: free text over the FTS5 index (subject, sender, recipients, body) plus Gmail-style
// operators. Returns conversation keys, newest first.
//
//   from:ada  to:me@x.com  subject:"q3 review"  has:attachment  is:unread  is:starred
//   in:inbox|sent|archive|trash|spam|drafts  label:Work  before:2026-01-31  after:2025-06-01
// ---------------------------------------------------------------------------

export type ParsedQuery = { text: string[]; where: string[]; args: Array<string | number>; columns: Array<{ column: 'sender' | 'recipients' | 'subject'; value: string }> }

const IN: Record<string, string> = { inbox: '\\Inbox', sent: '\\Sent', archive: '\\All', trash: '\\Trash', spam: '\\Junk', drafts: '\\Drafts' }

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { text: [], where: [], args: [], columns: [] }
  const like = (value: string) => `%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  for (const [, key, quoted, bare] of query.matchAll(/(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    const value = (quoted ?? bare ?? '').trim()
    if (!value) continue
    switch (key?.toLowerCase()) {
      // Sender, recipients and subject go through the FTS index (column filters), not a table scan.
      case 'from':
        parsed.columns.push({ column: 'sender', value })
        break
      case 'to':
        parsed.columns.push({ column: 'recipients', value })
        break
      case 'subject':
        parsed.columns.push({ column: 'subject', value })
        break
      case 'has':
        if (/^attach/i.test(value)) parsed.where.push(HAS_ATTACHMENTS_SQL)
        break
      case 'is':
        if (/^unread$/i.test(value)) parsed.where.push('m.seen = 0')
        else if (/^read$/i.test(value)) parsed.where.push('m.seen = 1')
        else if (/^(starred|flagged)$/i.test(value)) parsed.where.push('m.flagged = 1')
        break
      case 'in': {
        const use = IN[value.toLowerCase()]
        if (use) {
          parsed.where.push(
            `EXISTS (SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = m.id AND (mb.special_use = ? OR (? = '\\All' AND mb.special_use = '\\Archive')))`,
          )
          parsed.args.push(use, use)
        }
        break
      }
      case 'label':
        // A Gmail label, or one Jefi keeps itself (local-labels.ts), by name.
        parsed.where.push(
          `(EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND lower(ml.label) = ?)
            OR EXISTS (SELECT 1 FROM local_label_links ll JOIN local_labels l ON l.id = ll.label_id
                        WHERE ll.account_id = m.account_id AND ll.message_key = COALESCE(m.message_id, '#' || m.id) AND lower(l.name) = ?))`,
        )
        parsed.args.push(value.toLowerCase(), value.toLowerCase())
        break
      case 'before':
      case 'after': {
        const time = Date.parse(value)
        if (Number.isFinite(time)) {
          parsed.where.push(key.toLowerCase() === 'before' ? 'm.date < ?' : 'm.date >= ?')
          parsed.args.push(time)
        }
        break
      }
      default:
        parsed.text.push(key ? `${key}:${value}` : value)
    }
  }
  return parsed
}

/** FTS5 query for free text: every word must appear, each matched as a prefix ("inv" finds "invoice"). */
export function ftsQuery(words: string[], columns: ParsedQuery['columns'] = []) {
  const terms = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`)
  return [
    ...words.flatMap(terms),
    ...columns.flatMap(({ column, value }) => terms(value).map((t) => `${column} : ${t}`)),
  ].join(' ')
}

export function searchThreadKeys(db: MailDatabase, accountId: string, query: string, limit = 300): string[] {
  const parsed = parseQuery(query)
  const fts = ftsQuery(parsed.text, parsed.columns)
  if (!fts && parsed.where.length === 0) return []
  // With free text the FTS matches drive (CROSS JOIN keeps that order) and each is looked up by id;
  // otherwise it's the account's messages, narrowed by the operators.
  const rows = db
    .query(
      `SELECT COALESCE(m.thread_id, 'm' || m.id) AS key, max(m.date) AS latest
         FROM ${fts ? 'message_search s CROSS JOIN messages m ON m.id = s.rowid' : 'messages m'}
        WHERE ${fts ? 'message_search MATCH ?1 AND ' : '?1 IS NULL AND '}m.account_id = ?2
          ${parsed.where.map((w) => `AND ${w}`).join(' ')}
        GROUP BY key ORDER BY latest DESC LIMIT ${limit}`,
    )
    .all(fts || null, accountId, ...parsed.args) as Array<{ key: string }>
  return rows.map((r) => r.key)
}

/** The conversations a search finds, as list summaries in the search's order (newest first). */
export function searchThreads(db: MailDatabase, accountId: string, query: string, options: Pick<ThreadOptions, 'account' | 'limit'> = {}): MailThread[] {
  const keys = searchThreadKeys(db, accountId, query, options.limit)
  if (!keys.length) return []
  const found = loadThreads(db, accountId, { threadKeys: keys, ...(options.account ? { account: options.account } : {}) })
  const order = new Map(keys.map((k, i) => [`${accountId}:${k}`, i]))
  return found.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}
