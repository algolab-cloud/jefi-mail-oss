import type { MailDatabase } from './db'
import { uiThreadId } from './threading'
import { isSafeUnsubscribeUrl } from './unsubscribe-url'

// ---------------------------------------------------------------------------
// Scrub: clean-up reports over the local database (instant even on large mailboxes) and the
// conversations a clean-up would touch. Moving them reuses the ordinary queued moves, so every
// scrub syncs to the server and can be undone like any archive or delete.
// ---------------------------------------------------------------------------

export type ScrubGroupBy = 'senders' | 'newsletters' | 'age' | 'size'

export type ScrubSelector = { sender: string } | { olderThanDays: number } | { largerThanBytes: number }

export type ScrubGroup = {
  key: string
  selector: ScrubSelector
  label: string
  /** Sender address, or a description of the rule. */
  detail: string
  messages: number
  unread: number
  bytes: number
  latest: number
  /** The sender offers List-Unsubscribe. */
  canUnsubscribe: boolean
}

/** Mail somewhere worth cleaning: not already in Trash or Spam, and not only in Sent/Drafts. */
const LIVE = `EXISTS (SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id
  WHERE mm.message_id = m.id AND COALESCE(mb.special_use, '') NOT IN ('\\Trash', '\\Junk', '\\Sent', '\\Drafts'))`

/** Bulk senders that never set List-Unsubscribe still tend to look like this. */
const BULK_ADDRESS = `(m.list_unsubscribe IS NOT NULL OR lower(m.from_email) GLOB '*no-reply*' OR lower(m.from_email) GLOB '*noreply*'
  OR lower(m.from_email) GLOB 'newsletter*' OR lower(m.from_email) GLOB 'news@*' OR lower(m.from_email) GLOB 'notifications@*'
  OR lower(m.from_email) GLOB 'marketing@*' OR lower(m.from_email) GLOB 'updates@*' OR lower(m.from_email) GLOB 'digest@*')`

export type ScrubStats = {
  messages: number
  bytes: number
  unread: number
  /** Mail from bulk senders (newsletters, notifications). */
  bulk: { messages: number; bytes: number }
  /** Received more than a year ago. */
  old: { messages: number; bytes: number }
  /** Larger than 5 MB. */
  large: { messages: number; bytes: number }
  senders: number
  /** The last 12 months, oldest first; `month` is "YYYY-MM". */
  monthly: Array<{ month: string; bulk: number; other: number }>
  /** Messages per local day ("YYYY-MM-DD") over the last 53 weeks; days without mail are absent. */
  daily: Record<string, number>
  /** Messages by local weekday (0 = Sunday) and by local hour, over the same 53 weeks. */
  weekdays: number[]
  hours: number[]
}

/** Mailbox-wide numbers for the Clean up overview. */
export function scrubStats(db: MailDatabase, accountId: string, self: string, now = Date.now()): ScrubStats {
  const yearAgo = now - 365 * 86_400_000
  const big = 5 * 1024 * 1024
  const t = db
    .query(
      `SELECT count(*) AS messages, sum(COALESCE(m.size, 0)) AS bytes, sum(m.seen = 0) AS unread,
              sum(${BULK_ADDRESS}) AS bulkMessages, sum(CASE WHEN ${BULK_ADDRESS} THEN COALESCE(m.size, 0) ELSE 0 END) AS bulkBytes,
              sum(m.date < ?3) AS oldMessages, sum(CASE WHEN m.date < ?3 THEN COALESCE(m.size, 0) ELSE 0 END) AS oldBytes,
              sum(COALESCE(m.size, 0) > ?4) AS largeMessages, sum(CASE WHEN COALESCE(m.size, 0) > ?4 THEN m.size ELSE 0 END) AS largeBytes,
              count(DISTINCT lower(m.from_email)) AS senders
         FROM messages m
        WHERE m.account_id = ?1 AND m.from_email IS NOT NULL AND lower(m.from_email) <> ?2 AND ${LIVE}`,
    )
    .get(accountId, self.toLowerCase(), yearAgo, big) as Record<string, number | null>
  const start = new Date(now)
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCMonth(start.getUTCMonth() - 11)
  const rows = db
    .query(
      `SELECT strftime('%Y-%m', m.date / 1000, 'unixepoch') AS month, sum(${BULK_ADDRESS}) AS bulk, count(*) AS total
         FROM messages m
        WHERE m.account_id = ?1 AND m.from_email IS NOT NULL AND lower(m.from_email) <> ?2 AND m.date >= ?3 AND ${LIVE}
        GROUP BY month`,
    )
    .all(accountId, self.toLowerCase(), start.getTime()) as Array<{ month: string; bulk: number | null; total: number }>
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(start)
    d.setUTCMonth(start.getUTCMonth() + i)
    const month = d.toISOString().slice(0, 7)
    const r = byMonth.get(month)
    return { month, bulk: r?.bulk ?? 0, other: (r?.total ?? 0) - (r?.bulk ?? 0) }
  })
  const since = now - 371 * 86_400_000
  const recent = `FROM messages m WHERE m.account_id = ?1 AND m.from_email IS NOT NULL AND lower(m.from_email) <> ?2 AND m.date >= ?3 AND ${LIVE}`
  const grouped = (format: string) =>
    db.query(`SELECT strftime('${format}', m.date / 1000, 'unixepoch', 'localtime') AS k, count(*) AS c ${recent} GROUP BY k`).all(accountId, self.toLowerCase(), since) as Array<{ k: string; c: number }>
  const daily = Object.fromEntries(grouped('%Y-%m-%d').map((r) => [r.k, r.c]))
  const fill = (length: number, rows: Array<{ k: string; c: number }>) => {
    const out = Array.from({ length }, () => 0)
    for (const r of rows) out[Number(r.k)] = r.c
    return out
  }
  const weekdays = fill(7, grouped('%w'))
  const hours = fill(24, grouped('%H'))
  const n = (key: string) => t[key] ?? 0
  return {
    daily,
    weekdays,
    hours,
    messages: n('messages'),
    bytes: n('bytes'),
    unread: n('unread'),
    bulk: { messages: n('bulkMessages'), bytes: n('bulkBytes') },
    old: { messages: n('oldMessages'), bytes: n('oldBytes') },
    large: { messages: n('largeMessages'), bytes: n('largeBytes') },
    senders: n('senders'),
    monthly,
  }
}

const AGES = [1825, 730, 365, 180]
const SIZES = [25, 10, 5, 1].map((mb) => mb * 1024 * 1024)

export function scrubReport(db: MailDatabase, accountId: string, by: ScrubGroupBy, self: string): ScrubGroup[] {
  if (by === 'senders' || by === 'newsletters') {
    const rows = db
      .query(
        `SELECT lower(m.from_email) AS email, max(m.from_name) AS name, count(*) AS messages, sum(m.seen = 0) AS unread,
                sum(COALESCE(m.size, 0)) AS bytes, max(m.date) AS latest, max(m.list_unsubscribe IS NOT NULL) AS unsub
           FROM messages m
          WHERE m.account_id = ?1 AND m.from_email IS NOT NULL AND lower(m.from_email) <> ?2 AND ${LIVE}
                ${by === 'newsletters' ? `AND ${BULK_ADDRESS}` : ''}
          GROUP BY lower(m.from_email)
         HAVING count(*) > 1
          ORDER BY count(*) DESC
          LIMIT 300`,
      )
      .all(accountId, self.toLowerCase()) as Array<{ email: string; name: string | null; messages: number; unread: number; bytes: number; latest: number; unsub: number }>
    return rows.map((r) => ({
      key: `sender:${r.email}`,
      selector: { sender: r.email },
      label: r.name || r.email,
      detail: r.email,
      messages: r.messages,
      unread: r.unread,
      bytes: r.bytes,
      latest: r.latest,
      canUnsubscribe: r.unsub === 1,
    }))
  }
  const now = Date.now()
  const buckets = by === 'age' ? AGES.map((days) => ({ days })) : SIZES.map((bytes) => ({ bytes }))
  return buckets
    .map((bucket) => {
      const where = 'days' in bucket ? 'm.date < ?2' : 'COALESCE(m.size, 0) > ?2'
      const value = 'days' in bucket ? now - bucket.days * 86_400_000 : bucket.bytes
      const r = db
        .query(`SELECT count(*) AS messages, sum(m.seen = 0) AS unread, sum(COALESCE(m.size, 0)) AS bytes, max(m.date) AS latest FROM messages m WHERE m.account_id = ?1 AND ${where} AND ${LIVE}`)
        .get(accountId, value) as { messages: number; unread: number | null; bytes: number | null; latest: number | null }
      const label = 'days' in bucket ? `Older than ${bucket.days >= 365 ? `${bucket.days / 365} year${bucket.days >= 730 ? 's' : ''}` : '6 months'}` : `Larger than ${bucket.bytes / 1024 / 1024} MB`
      return {
        key: 'days' in bucket ? `age:${bucket.days}` : `size:${bucket.bytes}`,
        selector: ('days' in bucket ? { olderThanDays: bucket.days } : { largerThanBytes: bucket.bytes }) as ScrubSelector,
        label,
        detail: 'days' in bucket ? 'Everything received before then' : 'Mostly attachments',
        messages: r.messages,
        unread: r.unread ?? 0,
        bytes: r.bytes ?? 0,
        latest: r.latest ?? 0,
        canUnsubscribe: false,
      }
    })
    .filter((g) => g.messages > 0)
}

/** A sender with mail in the Inbox, with what the local mailbox already says about them. */
export type SenderProfile = ScrubGroup & {
  /** Messages the person sent to this address: someone they write to is someone they know. */
  wrote: number
  /** Their messages the person flagged, or answered. */
  flagged: number
  answered: number
  /** Looks like a bulk sender (List-Unsubscribe, no-reply, newsletter@…). */
  bulk: boolean
  /** Their newest subjects, newest first. */
  subjects: string[]
}

/**
 * Everyone with mail in the Inbox, busiest first, for the smart clean-up to sort. Counts cover all
 * of their live mail, because that's what a clean-up of the sender moves.
 */
export function senderProfiles(db: MailDatabase, accountId: string, self: string, limit = 200): SenderProfile[] {
  const me = self.toLowerCase()
  const rows = db
    .query(
      `SELECT lower(m.from_email) AS email, max(m.from_name) AS name, count(*) AS messages, sum(m.seen = 0) AS unread,
              sum(COALESCE(m.size, 0)) AS bytes, max(m.date) AS latest, max(m.list_unsubscribe IS NOT NULL) AS unsub,
              sum(m.flagged) AS flagged, sum(m.answered) AS answered, max(${BULK_ADDRESS}) AS bulk,
              max(EXISTS (SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = m.id AND mb.special_use = '\\Inbox')) AS in_inbox
         FROM messages m
        WHERE m.account_id = ?1 AND m.from_email IS NOT NULL AND lower(m.from_email) <> ?2 AND ${LIVE}
        GROUP BY lower(m.from_email)
       HAVING in_inbox = 1
        ORDER BY count(*) DESC, max(m.date) DESC
        LIMIT ?3`,
    )
    .all(accountId, me, limit) as Array<{ email: string; name: string | null; messages: number; unread: number; bytes: number; latest: number; unsub: number; flagged: number; answered: number; bulk: number }>
  if (!rows.length) return []
  const wanted = new Set(rows.map((r) => r.email))

  // Who the person writes to, from what they sent: one pass, not a lookup per sender.
  const wrote = new Map<string, number>()
  const sent = db
    .query(`SELECT to_json, cc_json FROM messages WHERE account_id = ? AND lower(from_email) = ? ORDER BY date DESC LIMIT 5000`)
    .all(accountId, me) as Array<{ to_json: string; cc_json: string }>
  for (const row of sent) {
    for (const json of [row.to_json, row.cc_json]) {
      for (const address of addresses(json)) if (wanted.has(address)) wrote.set(address, (wrote.get(address) ?? 0) + 1)
    }
  }

  const subjects = new Map<string, string[]>()
  const recent = db
    .query(
      `SELECT e, subject FROM (
         SELECT lower(m.from_email) AS e, m.subject, row_number() OVER (PARTITION BY lower(m.from_email) ORDER BY m.date DESC) AS rn
           FROM messages m
          WHERE m.account_id = ?1 AND m.from_email IS NOT NULL AND lower(m.from_email) <> ?2 AND ${LIVE})
        WHERE rn <= 3`,
    )
    .all(accountId, me) as Array<{ e: string; subject: string }>
  for (const r of recent) if (wanted.has(r.e)) subjects.set(r.e, [...(subjects.get(r.e) ?? []), r.subject])

  return rows.map((r) => ({
    key: `sender:${r.email}`,
    selector: { sender: r.email },
    label: r.name || r.email,
    detail: r.email,
    messages: r.messages,
    unread: r.unread ?? 0,
    bytes: r.bytes ?? 0,
    latest: r.latest,
    canUnsubscribe: r.unsub === 1,
    wrote: wrote.get(r.email) ?? 0,
    flagged: r.flagged ?? 0,
    answered: r.answered ?? 0,
    bulk: r.bulk === 1,
    subjects: subjects.get(r.email) ?? [],
  }))
}

/** One conversation, as the smart clean-up shows it to the model: who, what, and a preview. */
export type ThreadPeek = { threadId: string; sender: string; fromName: string; subject: string; snippet: string; latest: number; flagged: boolean }

type PeekRow = { id: number; thread_id: string | null; sender: string; from_name: string | null; subject: string; snippet: string; date: number; flagged: number }

/** Messages (newest first) as conversations: the newest message speaks for each; starred if any is. */
function peeks(accountId: string, rows: PeekRow[], take: (row: PeekRow, count: number) => boolean): ThreadPeek[] {
  const out = new Map<string, ThreadPeek>()
  for (const row of rows) {
    const threadId = uiThreadId(accountId, row.thread_id, row.id)
    const seen = out.get(threadId)
    if (seen) {
      seen.flagged ||= row.flagged === 1
      continue
    }
    if (!take(row, out.size)) continue
    out.set(threadId, { threadId, sender: row.sender, fromName: row.from_name || row.sender, subject: row.subject, snippet: row.snippet, latest: row.date, flagged: row.flagged === 1 })
  }
  return [...out.values()]
}

/**
 * The newest conversations of each sender (live mail, `perSender` at most), so the smart clean-up
 * can look for the ones worth keeping before it clears the rest.
 */
export function senderThreads(db: MailDatabase, accountId: string, senders: string[], perSender = 25): ThreadPeek[] {
  if (!senders.length) return []
  const list = [...new Set(senders.map((s) => s.toLowerCase()))]
  const rows = db
    .query(
      `SELECT m.id, m.thread_id, lower(m.from_email) AS sender, m.from_name, m.subject, m.snippet, m.date, m.flagged
         FROM messages m
        WHERE m.account_id = ?1 AND lower(m.from_email) IN (${list.map((_, i) => `?${i + 2}`).join(', ')}) AND ${LIVE}
        ORDER BY m.date DESC`,
    )
    .all(accountId, ...list) as PeekRow[]
  const counts = new Map<string, number>()
  return peeks(accountId, rows, (row) => {
    const count = counts.get(row.sender) ?? 0
    if (count >= perSender) return false
    counts.set(row.sender, count + 1)
    return true
  })
}

/** The newest conversations in Spam, for the smart clean-up to look for real mail misfiled there. */
export function spamThreads(db: MailDatabase, accountId: string, limit = 100): ThreadPeek[] {
  const rows = db
    .query(
      `SELECT m.id, m.thread_id, lower(m.from_email) AS sender, m.from_name, m.subject, m.snippet, m.date, m.flagged
         FROM messages m
        WHERE m.account_id = ?1 AND m.from_email IS NOT NULL
          AND EXISTS (SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = m.id AND mb.special_use = '\\Junk')
        ORDER BY m.date DESC
        LIMIT ?2`,
    )
    .all(accountId, limit * 4) as PeekRow[]
  return peeks(accountId, rows, (_, count) => count < limit)
}

/** Lower-cased addresses in a stored to/cc list; a malformed list is no one. */
function addresses(json: string): string[] {
  try {
    const list = JSON.parse(json) as Array<{ email?: unknown }>
    return Array.isArray(list) ? list.flatMap((a) => (typeof a?.email === 'string' && a.email ? [a.email.trim().toLowerCase()] : [])) : []
  } catch {
    return []
  }
}

/**
 * The conversations a scrub would move, newest first, skipping the `keepLatest` most recent.
 * `inInbox` records where each lived, so Undo can put it back.
 */
export function scrubTargets(db: MailDatabase, accountId: string, selector: ScrubSelector, keepLatest = 0, except: ReadonlySet<string> = new Set()): Array<{ threadId: string; inInbox: boolean }> {
  const [where, value] = selectorWhere(selector)
  const rows = db
    .query(
      `SELECT m.thread_id, min(m.id) AS id, max(m.date) AS latest,
              max(EXISTS (SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = m.id AND mb.special_use = '\\Inbox')) AS in_inbox
         FROM messages m
        WHERE m.account_id = ?1 AND ${where} AND ${LIVE}
        GROUP BY COALESCE(m.thread_id, 'm' || m.id)
        ORDER BY latest DESC`,
    )
    .all(accountId, value) as Array<{ thread_id: string | null; id: number; latest: number; in_inbox: number }>
  return rows
    .slice(keepLatest)
    .map((r) => ({ threadId: uiThreadId(accountId, r.thread_id, r.id), inInbox: r.in_inbox === 1 }))
    .filter((target) => !except.has(target.threadId))
}

/** The SQL condition (bound to ?2) a selector picks messages by. */
function selectorWhere(selector: ScrubSelector): [string, string | number] {
  return 'sender' in selector
    ? ['lower(m.from_email) = ?2', selector.sender.toLowerCase()]
    : 'olderThanDays' in selector
      ? ['m.date < ?2', Date.now() - selector.olderThanDays * 86_400_000]
      : ['COALESCE(m.size, 0) > ?2', selector.largerThanBytes]
}

/**
 * The messages a "Delete forever" erases: exactly those the selector matches (the ones the report
 * counted), not every message in their conversations; a reply that came after the cut-off, or from
 * someone else, stays. Conversations are still the unit for `keepLatest` and `except`, as for a move.
 */
export function scrubMessageIds(db: MailDatabase, accountId: string, selector: ScrubSelector, keepLatest = 0, except: ReadonlySet<string> = new Set()): number[] {
  const [where, value] = selectorWhere(selector)
  const rows = db
    .query(`SELECT m.id, m.thread_id FROM messages m WHERE m.account_id = ?1 AND ${where} AND ${LIVE} ORDER BY m.date DESC, m.id DESC`)
    .all(accountId, value) as Array<{ id: number; thread_id: string | null }>
  const kept = new Set(scrubTargets(db, accountId, selector).slice(0, keepLatest).map((t) => t.threadId))
  return rows.filter((r) => {
    const threadId = uiThreadId(accountId, r.thread_id, r.id)
    return !kept.has(threadId) && !except.has(threadId)
  }).map((r) => r.id)
}

export type Unsubscribe = { oneClick: string | null; link: string | null; mailto: string | null }

/** The ways out a sender offers, from its newest message that carries List-Unsubscribe. */
export function unsubscribeOptions(db: MailDatabase, accountId: string, sender: string): Unsubscribe | null {
  const row = db
    .query(
      `SELECT list_unsubscribe AS value, list_unsubscribe_post AS post FROM messages
        WHERE account_id = ? AND lower(from_email) = ? AND list_unsubscribe IS NOT NULL ORDER BY date DESC LIMIT 1`,
    )
    .get(accountId, sender.toLowerCase()) as { value: string; post: number } | null
  return row ? parseUnsubscribe(row.value, row.post === 1) : null
}

export function parseUnsubscribe(value: string, post: boolean): Unsubscribe {
  const targets = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim())
  const link = targets.find((t) => /^https:/i.test(t)) ?? null
  // One-click POSTs without asking, so only to a public host; any other link is left for the person to open.
  return { oneClick: post && link && isSafeUnsubscribeUrl(link) ? link : null, link, mailto: targets.find((t) => /^mailto:/i.test(t)) ?? null }
}
