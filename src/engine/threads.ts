import { parseSignIn } from '../sign-in-code'
import { withDemoFace } from '../demo-faces'
import { htmlToMarkdown } from './html-to-markdown'
import { screenedSenders } from './screener'
import { snoozeLabel, snoozedThreads } from './snooze'
import type { Attachment, DraftFields, FaceSpec, MailAddress, MailFolder, FolderId, Label, LabelTone, MailThread, Message } from '../data'
import type { Account } from '../accounts'
import { isReadOnly, type MailDatabase } from './db'
import { HAS_ATTACHMENTS_SQL, INVITE_PART_SQL, listDrafts, type Address } from './mail-store'
import { gmailLabelId, gmailLabelName } from './pending-ops'
import { listLocalLabels, messageKeySql } from './local-labels'
import { baseView, folderPathOf, labelOf, threadInView, type MailboxView } from '../view'
import { assignThreads, uiThreadId } from './threading'
import { parseUnsubscribe } from './scrub'
import { listOutgoing, type OutboxEntry } from './outbox'

// ---------------------------------------------------------------------------
// SQLite rows → the UI's MailThread shape: one entry per conversation (threading.ts), newest
// conversation first. HTML bodies are shown as their text part until sanitized HTML rendering
// (lume-bpl.1).
// ---------------------------------------------------------------------------

/**
 * Where a conversation shows up when its messages live in several folders: the most "active" place
 * wins, so a thread with a new reply in the inbox is in Inbox even though your own reply sits in Sent.
 */
export const FOLDER_RANK: Array<[string, FolderId]> = [
  ['\\Inbox', 'inbox'],
  ['\\Drafts', 'drafts'],
  ['\\Archive', 'archive'],
  ['\\All', 'archive'],
  ['\\Sent', 'sent'],
  ['\\Junk', 'spam'],
  ['\\Trash', 'trash'],
]

export const folderForSpecialUse = (specialUse: string | null): FolderId | null => FOLDER_RANK.find(([use]) => use === specialUse)?.[1] ?? null

type Row = {
  /** The conversation key and latest date the window ordered by. */
  list_key: string
  list_latest: number
  id: number
  thread_id: string | null
  subject: string
  from_name: string | null
  from_email: string | null
  to_json: string
  cc_json: string
  reply_to_json: string
  message_id: string | null
  references_json: string
  date: number
  snippet: string
  has_attachments: number
  seen: number
  flagged: number
  special_uses: string | null
  /** Paths of the plain (non-special-use) folders holding this message, \u001f-separated. */
  custom_paths: string | null
  text: string | null
  html: string | null
  /** Set when bodies were requested and this message has one stored. */
  has_body: number | null
  labels: string | null
  /** Jefi's own labels on this message (local_labels ids), \u001f-separated. */
  local_labels: string | null
  list_unsubscribe: string | null
  list_unsubscribe_post: number
  /** The sign-in code or link found in the body when it was stored (src/sign-in-code.ts), as JSON. */
  sign_in: string | null
}

export type ThreadOptions = {
  /** Newest conversations to load (default 500). The list grows this a page at a time. */
  limit?: number
  now?: Date
  account?: { name: string; email: string; face?: FaceSpec }
  /** Include message bodies. Off for list snapshots: they are most of the payload and aren't shown. */
  bodies?: boolean
  /** Load one conversation only. */
  threadId?: string
  /** Load just these conversations (keys as stored: thread_id, or m<id>). */
  threadKeys?: string[]
  /** Narrow to one view in SQL, so `limit` counts that view's mail and not the account's newest. */
  view?: MailboxView
}

/** Conversations in each page of a view. */
export const VIEW_PAGE = 200

/**
 * The messages the list is built from, for a `WITH` clause taking the account id as ?1: everything
 * stored for the account except the server copies of Jefi's own drafts (the draft row stands in).
 */
const SHOWN_MESSAGES = `own_drafts AS (
         -- Server copies of Jefi's own drafts: the draft row is what's shown (and edited).
         SELECT remote_message_id AS message_id FROM drafts WHERE account_id = ?1 AND remote_message_id IS NOT NULL
         UNION SELECT message_id FROM draft_removals WHERE account_id = ?1
       ),
       shown AS (
         SELECT * FROM messages
          WHERE account_id = ?1 AND (message_id IS NULL OR message_id NOT IN (SELECT message_id FROM own_drafts))
       )`

/**
 * A condition on the conversations summary (`c`, migration 16) picking the conversations a view
 * holds, so a LIMIT over it counts that view's mail rather than the account's newest. `param` is the
 * placeholder its argument binds to.
 *
 * Null when the view can't be narrowed in SQL: Snoozed and the Screener are local state, the Outbox
 * is the UI's own. The caller falls back to the account-wide window for those, which is where they
 * already live.
 *
 * Deliberately a shade wider than `threadInView`: a conversation a snooze or the Screener has moved
 * aside is fetched here and dropped by that shared rule, which has the final say on both sides.
 */
function viewKeys(accountId: string, asked: MailboxView, param: string): { sql: string; argument?: string } | null {
  // One account's share of All Inboxes is its Inbox.
  const view = baseView(asked)
  const key = `COALESCE(s.thread_id, 'm' || s.id)`
  const path = folderPathOf(view)
  if (path !== null) {
    return {
      sql: `c.key IN (SELECT ${key} FROM mailboxes mb JOIN message_mailboxes mm ON mm.mailbox_id = mb.id JOIN shown s ON s.id = mm.message_id
                       WHERE mb.account_id = ?1 AND mb.special_use IS NULL AND mb.path = ${param})`,
      argument: path,
    }
  }
  const label = labelOf(view)
  if (label !== null) {
    const name = gmailLabelName(accountId, label)
    if (name !== null) return { sql: `c.key IN (SELECT ${key} FROM message_labels ml JOIN shown s ON s.id = ml.message_id WHERE ml.label = ${param})`, argument: name }
    // Jefi's own label (local-labels.ts): by Message-ID, or by row for a message without one.
    return {
      sql: `c.key IN (SELECT ${key} FROM local_label_links ll JOIN shown s ON s.message_id = ll.message_key WHERE ll.account_id = ?1 AND ll.label_id = ${param}
                      UNION SELECT ${key} FROM local_label_links ll JOIN shown s ON s.id = CAST(substr(ll.message_key, 2) AS INTEGER)
                       WHERE ll.account_id = ?1 AND ll.label_id = ${param} AND s.message_id IS NULL AND ll.message_key = '#' || s.id)`,
      argument: label,
    }
  }
  if (view === 'starred') return { sql: `c.key IN (SELECT ${key} FROM shown s WHERE s.flagged = 1)` }
  // The mailbox a conversation is shown in is the best-ranked one holding any of its messages.
  return FOLDER_RANK.some(([, id]) => id === view) ? { sql: `c.place = ${param}`, argument: view } : null
}

/** Where a view page ends: the last conversation's latest date and key. Opaque to the UI. */
export type ViewCursor = { at: number; key: string }

export type ViewPageOptions = ThreadOptions & {
  /** Continue below this cursor (the previous page's `nextCursor`). */
  after?: ViewCursor | null
  /** Also report what changed since this list revision (see ViewChanges). */
  since?: number
}

/**
 * What changed since a revision, for a list already paged past its first page: every conversation
 * touched since then (in the view or not: one that moved out needs its new folder to drop out), and
 * the ids of those that no longer exist. 'reset' when that can't be told cheaply (too much changed,
 * or a change too broad to stamp, see migration 15): the caller reloads what it had instead.
 */
export type ViewChanges = { threads: MailThread[]; removed: string[] } | 'reset'

export type ViewPage = { threads: MailThread[]; nextCursor: ViewCursor | null; hasMore: boolean; revision: number; changes?: ViewChanges }

/** More changed conversations than this and patching loses to reloading. */
const MAX_CHANGES = 500
/** Removal records older than this many revisions are pruned; a list older than that reloads. */
export const REMOVAL_WINDOW = 200_000

/** The account's list revision: bumped by every change the list can show (migration 15). */
export function listRevision(db: MailDatabase, accountId: string): { rev: number; resetRev: number } {
  const row = db.query('SELECT list_rev AS rev, list_reset_rev AS resetRev FROM accounts WHERE id = ?').get(accountId) as { rev: number; resetRev: number } | null
  return row ?? { rev: 0, resetRev: 0 }
}

/** Drops removal records no list can still ask about. */
export function pruneListRemovals(db: MailDatabase, accountId: string) {
  const { rev } = listRevision(db, accountId)
  if (rev > REMOVAL_WINDOW) db.run('DELETE FROM list_removals WHERE account_id = ? AND rev <= ?', [accountId, rev - REMOVAL_WINDOW])
}

/**
 * One page of a view: its conversations newest first (latest date, then key, so equal dates keep a
 * stable order), a cursor for the next page, and whether there is one. Summaries only, like a list
 * snapshot. Null when the view isn't one SQL can narrow (see viewKeys): the account window covers it.
 */
export function loadView(db: MailDatabase, accountId: string, view: MailboxView, options: ViewPageOptions = {}): ViewPage | null {
  if (!viewKeys(accountId, view, '?5')) return null
  const limit = options.limit ?? VIEW_PAGE
  const after = options.after ?? null
  // One past the page says whether there is more, without counting the whole view.
  const { threads, keys } = queryThreads(db, accountId, { ...options, limit: limit + 1, view, after, extras: !after })
  // Read after the query: threading, which it runs first, can stamp messages itself.
  const { rev } = listRevision(db, accountId)
  const hasMore = keys.length > limit
  const extra = hasMore ? `${accountId}:${keys[limit]!.key}` : null
  const last = keys[Math.min(limit, keys.length) - 1]
  return {
    threads: threads.filter((thread) => thread.id !== extra && threadInView(thread, view)),
    nextCursor: hasMore && last ? { at: last.latest, key: last.key } : null,
    hasMore,
    revision: rev,
    ...(options.since === undefined ? {} : { changes: viewChanges(db, accountId, options.since, options) }),
  }
}

function viewChanges(db: MailDatabase, accountId: string, since: number, options: ThreadOptions): ViewChanges {
  const { rev, resetRev } = listRevision(db, accountId)
  if (since < resetRev || rev - since >= REMOVAL_WINDOW) return 'reset'
  if (since >= rev) return { threads: [], removed: [] }
  const touched = db
    .query("SELECT DISTINCT COALESCE(thread_id, 'm' || id) AS key FROM messages WHERE account_id = ? AND list_rev > ? LIMIT ?")
    .all(accountId, since, MAX_CHANGES + 1) as Array<{ key: string }>
  const gone = db.query('SELECT DISTINCT key FROM list_removals WHERE account_id = ? AND rev > ? LIMIT ?').all(accountId, since, MAX_CHANGES + 1) as Array<{ key: string }>
  const keys = [...new Set([...touched, ...gone].map((r) => r.key))]
  if (keys.length > MAX_CHANGES) return 'reset'
  if (!keys.length) return { threads: [], removed: [] }
  const ids = new Set(keys.map((key) => `${accountId}:${key}`))
  const { view: _view, limit: _limit, after: _after, since: _since, ...rest } = options as ViewPageOptions
  const threads = loadThreads(db, accountId, { ...rest, threadKeys: keys, limit: keys.length }).filter((thread) => ids.has(thread.id))
  const present = new Set(threads.map((thread) => thread.id))
  return { threads, removed: [...ids].filter((id) => !present.has(id)) }
}

/**
 * Whether the account holds conversations older than the newest `limit`, so the list can offer to
 * load more. Counts conversation keys one past the limit and stops there: cheap on a huge mailbox.
 */
export function hasOlderThreads(db: MailDatabase, accountId: string, limit: number): boolean {
  const row = db.query('SELECT count(*) AS c FROM (SELECT 1 FROM conversations WHERE account_id = ? LIMIT ?)').get(accountId, limit + 1) as { c: number }
  return row.c > limit
}

/** One conversation with its message bodies, for the reading pane. */
export function loadThread(db: MailDatabase, accountId: string, threadId: string, options: ThreadOptions = {}): MailThread | null {
  return loadThreads(db, accountId, { ...options, bodies: true, threadId })[0] ?? null
}

export function loadThreads(db: MailDatabase, accountId: string, options: ThreadOptions = {}): MailThread[] {
  return queryThreads(db, accountId, options).threads
}

/**
 * How many unread Inbox conversations an account has: the number unreadAcrossAccounts would list
 * with no limit, counted in SQL off the conversations summary instead of building each one, so a
 * mailbox with tens of thousands unread answers in milliseconds (the menu-bar extensions poll it).
 * The same rule piece by piece: listed in the Inbox, an unread message the list shows, not snoozed,
 * and its newest message from someone else not a sender waiting in the Screener.
 */
export function countInboxUnread(db: MailDatabase, account: Pick<Account, 'id' | 'email'>): number {
  if (!isReadOnly(db)) assignThreads(db, account.id)
  const self = account.email.toLowerCase()
  const screened = screenedSenders(db, account.id, self)
  // A conversation's messages the list draws (shown, and held by some mailbox), by thread or by id:
  // two lookups rather than one OR, so each stays on its index.
  const drawn = `(s.message_id IS NULL OR s.message_id NOT IN (SELECT message_id FROM own_drafts))
    AND EXISTS (SELECT 1 FROM message_mailboxes mm WHERE mm.message_id = s.id)`
  const byThread = `FROM messages s WHERE s.account_id = ?1 AND s.thread_id = c.thread_id AND ${drawn}`
  const byId = `FROM messages s WHERE s.id = c.message_id AND ${drawn}`
  const sender = `lower(COALESCE(s.from_email, ''))`
  const row = db
    .query(
      `WITH ${SHOWN_MESSAGES}
       SELECT count(*) AS n FROM conversations c
        WHERE c.account_id = ?1 AND c.place = 'inbox'
          AND (EXISTS (SELECT 1 ${byThread} AND s.seen = 0) OR EXISTS (SELECT 1 ${byId} AND s.seen = 0))
          AND ?1 || ':' || c.key NOT IN (SELECT thread_id FROM snoozes WHERE account_id = ?1)
          AND (?2 IS NULL OR COALESCE(
                (SELECT ${sender} ${byThread} AND ${sender} <> ?3 ORDER BY s.date DESC, s.id DESC LIMIT 1),
                (SELECT ${sender} ${byId} AND ${sender} <> ?3),
                '') NOT IN (SELECT value FROM json_each(?2)))`,
    )
    .get(account.id, screened.size ? JSON.stringify([...screened]) : null, self) as { n: number }
  return row.n
}

/** An unread Inbox conversation and the account it came in to. */
export type UnreadThread = { account: { id: string; email: string; label?: string }; thread: MailThread }

/**
 * The newest unread Inbox conversations across every account, newest first, at most `limit`.
 * Summaries only. Junk, Trash, snoozed mail and senders waiting in the Screener are left out, the
 * same as the Inbox itself shows (threadInView has the final say).
 */
export function unreadAcrossAccounts(db: MailDatabase, accounts: Array<Pick<Account, 'id' | 'name' | 'email' | 'face' | 'label'>>, limit: number, now = new Date()): UnreadThread[] {
  const all: UnreadThread[] = []
  for (const account of accounts) {
    // A little headroom: the Screener and snoozes can drop some of the rows the SQL window picks.
    const { threads } = queryThreads(db, account.id, { limit: limit + 20, now, view: 'inbox', unread: true, extras: false, account: { name: account.name, email: account.email, face: account.face } })
    const tag = { id: account.id, email: account.email, ...(account.label?.trim() ? { label: account.label.trim() } : {}) }
    for (const thread of threads) if (thread.unread && threadInView(thread, 'inbox')) all.push({ account: tag, thread })
  }
  return all.sort((a, b) => (b.thread.at ?? 0) - (a.thread.at ?? 0)).slice(0, Math.max(0, limit))
}

type QueryOptions = ThreadOptions & {
  after?: ViewCursor | null
  /** Drafts and the Outbox ride along the first page only (default on). */
  extras?: boolean
  /** Only conversations with an unread message. */
  unread?: boolean
}

/** The conversations, and the keys the SQL window picked in its order. */
function queryThreads(db: MailDatabase, accountId: string, options: QueryOptions): { threads: MailThread[]; keys: Array<{ key: string; latest: number }> } {
  // A read-only connection (the CLI) leaves unthreaded mail as single messages until the app threads it.
  if (!isReadOnly(db)) assignThreads(db, accountId)
  const limit = options.limit ?? 500
  const one = options.threadId ? options.threadId.replace(`${accountId}:`, '') : null
  const keys = options.threadKeys ? JSON.stringify(options.threadKeys) : one ? JSON.stringify([one]) : null
  const filter = options.view ? viewKeys(accountId, options.view, '?5') : null
  // The window reads its keys off the summary's indexes, then fetches each conversation's messages
  // by thread (or id, for one not threaded yet) instead of grouping the whole account.
  const where = [
    keys ? 'c.key IN (SELECT value FROM json_each(?4))' : '?4 IS NULL',
    filter ? filter.sql : '?5 IS NULL',
    options.after ? '(c.latest, c.key) < (?6, ?7)' : '?6 IS NULL AND ?7 IS NULL',
    ...(options.unread ? [`c.key IN (SELECT COALESCE(s.thread_id, 'm' || s.id) FROM shown s WHERE s.seen = 0)`] : []),
  ]
  const rows = db
    .query(
      `WITH ${SHOWN_MESSAGES},
       recent AS (
         SELECT c.key, c.latest, c.thread_id, c.message_id FROM conversations c
          WHERE c.account_id = ?1 AND ${where.join(' AND ')}
          ORDER BY c.latest DESC, c.key DESC LIMIT ?2
       ),
       members AS (
         SELECT r.key, r.latest, m.id FROM recent r CROSS JOIN messages m ON m.account_id = ?1 AND m.thread_id = r.thread_id WHERE r.thread_id IS NOT NULL
         UNION ALL
         SELECT r.key, r.latest, r.message_id FROM recent r WHERE r.thread_id IS NULL
       )
       SELECT r.key AS list_key, r.latest AS list_latest, m.id, m.thread_id, m.subject, m.from_name, m.from_email, m.to_json, m.cc_json, m.reply_to_json, m.message_id, m.references_json,
              m.date, m.snippet, ${HAS_ATTACHMENTS_SQL} AS has_attachments,
              m.seen, m.flagged, group_concat(mb.special_use, '|') AS special_uses,
              group_concat(CASE WHEN mb.special_use IS NULL THEN mb.path END, char(31)) AS custom_paths, b.text, b.html, b.message_id AS has_body,
              (SELECT group_concat(label, char(31)) FROM message_labels ml WHERE ml.message_id = m.id) AS labels,
              (SELECT group_concat(ll.label_id, char(31)) FROM local_label_links ll WHERE ll.account_id = ?1 AND ll.message_key = ${messageKeySql('m')}) AS local_labels,
              m.list_unsubscribe, m.list_unsubscribe_post, m.sign_in
         FROM members r
         CROSS JOIN messages m ON m.id = r.id
         JOIN message_mailboxes mm ON mm.message_id = m.id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
         LEFT JOIN bodies b ON (?3 = 1 AND b.message_id = m.id)
        WHERE m.account_id = ?1 AND (m.message_id IS NULL OR m.message_id NOT IN (SELECT message_id FROM own_drafts))
        GROUP BY m.id
        ORDER BY r.latest DESC, r.key DESC, m.date ASC`,
    )
    .all(
      ...([
        accountId,
        options.threadKeys ? Math.max(limit, options.threadKeys.length) : limit,
        options.bodies ? 1 : 0,
        keys,
        filter?.argument ?? null,
        options.after?.at ?? null,
        options.after?.key ?? null,
      ] as never[]),
    ) as Row[]
  const picked: Array<{ key: string; latest: number }> = []
  for (const row of rows) if (picked.at(-1)?.key !== row.list_key) picked.push({ key: row.list_key, latest: row.list_latest })

  // Attachment rows for the reader; list snapshots don't show them.
  const files = options.bodies ? attachmentsOf(db, rows.map((r) => r.id)) : undefined

  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = uiThreadId(accountId, row.thread_id, row.id)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const now = options.now ?? new Date()
  const threads: MailThread[] = []
  for (const [id, messages] of groups) {
    const uses = new Set(messages.flatMap((m) => (m.special_uses ?? '').split('|').filter(Boolean)))
    const folders = [...new Set(messages.flatMap((m) => (m.custom_paths ? m.custom_paths.split('\u001f') : [])))].sort()
    const folder = FOLDER_RANK.find(([use]) => uses.has(use))?.[1]
    // Only in custom folders: shown under Folders in the sidebar, not in any built-in mailbox.
    if (!folder && !folders.length) continue
    threads.push({ ...toThread(accountId, id, messages, folder ?? 'archive', now, files), folders, ...(folder ? {} : { onlyInFolders: true }) })
  }
  // Snoozed conversations sit in Snoozed (archived on the server) until they're due back.
  const snoozed = snoozedThreads(db, accountId)
  if (snoozed.size) {
    for (const thread of threads) {
      const until = snoozed.get(thread.id)
      if (until) Object.assign(thread, { folder: 'snoozed', snoozeUntil: snoozeLabel(until, now) })
    }
  }
  // Screener: Inbox conversations whose sender is new and undecided wait outside the Inbox.
  const screened = options.account ? screenedSenders(db, accountId, options.account.email) : new Set<string>()
  if (screened.size) {
    const self = options.account!.email.toLowerCase()
    for (const thread of threads) {
      const sender = [...thread.messages].reverse().find((m) => m.email.toLowerCase() !== self)?.email.toLowerCase()
      if (thread.folder === 'inbox' && sender && screened.has(sender)) thread.screened = true
    }
  }
  // Jefi's drafts come from the drafts table; their server copies were left out above.
  if (options.extras === false) return { threads, keys: picked }
  if (!one && !options.threadKeys) for (const row of listDrafts(db, accountId)) threads.push(draftThread(row, options.account, now))
  else for (const row of listDrafts(db, accountId).filter((d) => d.id === options.threadId)) threads.push(draftThread(row, options.account, now))
  const outgoing = listOutgoing(db, accountId).filter((entry) => {
    if (options.threadKeys) return options.threadKeys.includes(entry.id) || options.threadKeys.includes(entry.threadId)
    return !options.threadId || entry.id === options.threadId || entry.threadId === options.threadId
  })
  for (const entry of outgoing) {
    if (entry.kind === 'message') {
      threads.push(outboxThread(entry, options.account, now))
      continue
    }
    const parent = threads.find((thread) => thread.id === entry.threadId)
    if (!parent) {
      // The conversation can be outside the current window or deleted. Keep the failed reply
      // discoverable and actionable in Outbox instead of hiding a live queue entry.
      threads.push(outboxThread(entry, options.account, now))
      continue
    }
    // If sync already found the server copy, do not draw a second optimistic reply while the queue
    // reconciler changes the row to sent.
    if (parent.messages.some((message) => message.messageId === entry.messageId)) continue
    const reply = pendingReplyMessage(entry, options.account, now)
    parent.messages.push(reply)
    parent.messages.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
    if (entry.createdAt >= (parent.at ?? 0)) {
      parent.snippet = firstLine(entry.mail.body) || parent.snippet
      parent.date = formatListDate(entry.createdAt, now)
      parent.at = entry.createdAt
      parent.group = groupOf(entry.createdAt, now)
    }
    parent.unread = false
  }
  return { threads, keys: picked }
}

function pendingReplyMessage(entry: OutboxEntry, account: ThreadOptions['account'], now: Date): Message {
  const recipients = [...entry.mail.to, ...entry.mail.cc, ...entry.mail.bcc]
  const face = account?.face ?? { letter: initialsOf(account?.name ?? 'Me') }
  return {
    id: entry.id,
    from: account?.name ?? 'Me',
    email: account?.email ?? '',
    to: recipients.join(', ') || 'no recipients',
    face,
    time: formatTime(entry.createdAt, now),
    timestamp: entry.createdAt,
    paragraphs: [],
    markdown: entry.mail.body.trim() ? entry.mail.body : '_(empty message)_',
    attachments: entry.mail.attachments?.length ? entry.mail.attachments : undefined,
    status: entry.state === 'failed' ? (entry.unconfirmed ? 'unconfirmed' : 'failed') : 'sending',
  }
}

function outboxThread(entry: OutboxEntry, account: ThreadOptions['account'], now: Date): MailThread {
  if (entry.state === 'sent') throw new Error('A sent message cannot be shown in the Outbox.')
  const recipients = [...entry.mail.to, ...entry.mail.cc, ...entry.mail.bcc]
  const face = account?.face ?? { letter: initialsOf(account?.name ?? 'Me') }
  return {
    id: entry.id,
    sender: account?.name ?? 'Me',
    subject: entry.mail.subject.trim() || '(no subject)',
    snippet: firstLine(entry.mail.body) || '(no content)',
    date: formatListDate(entry.createdAt, now),
    at: entry.createdAt,
    group: groupOf(entry.createdAt, now),
    unread: false,
    starred: false,
    icons: entry.mail.attachments?.length ? ['paperclip'] : [],
    priority: false,
    tag: 'Outbox',
    face,
    folder: 'outbox',
    labels: [],
    folders: [],
    draft: entry.mail,
    sendState: entry.state,
    sendAttempts: entry.attempts,
    ...(entry.lastError ? { sendError: entry.lastError } : {}),
    ...(entry.state === 'failed' && entry.nextAttemptAt !== null ? { sendRetryAt: entry.nextAttemptAt } : {}),
    ...(entry.permanent ? { sendPermanent: true } : {}),
    ...(entry.retryStopped ? { sendRetryStopped: true } : {}),
    ...(entry.unconfirmed ? { sendUnconfirmed: true } : {}),
    ...(entry.state === 'queued' && entry.attempts === 0 && entry.nextAttemptAt !== null
      ? { scheduledFor: snoozeLabel(entry.nextAttemptAt, now) }
      : {}),
    messages: [
      {
        id: `${entry.id}-1`,
        from: account?.name ?? 'Me',
        email: account?.email ?? '',
        to: recipients.join(', ') || 'no recipients',
        face,
        time: formatTime(entry.createdAt, now),
        timestamp: entry.createdAt,
        paragraphs: [],
        markdown: entry.mail.body.trim() ? entry.mail.body : '_(empty message)_',
        attachments: entry.mail.attachments?.length ? entry.mail.attachments : undefined,
      },
    ],
  }
}

function draftThread(row: { id: string; mail_json: string; updated_at: number }, account: ThreadOptions['account'], now: Date): MailThread {
  const mail = JSON.parse(row.mail_json) as DraftFields
  const recipients = [...mail.to, ...mail.cc, ...mail.bcc]
  const face = { letter: initialsOf(account?.name ?? 'Draft') }
  return {
    id: row.id,
    sender: 'Draft',
    subject: mail.subject.trim() || '(no subject)',
    snippet: firstLine(mail.body) || '(no content)',
    date: formatListDate(row.updated_at, now),
    at: row.updated_at,
    group: groupOf(row.updated_at, now),
    unread: false,
    starred: false,
    icons: mail.attachments?.length ? ['paperclip'] : [],
    priority: false,
    tag: 'Drafts',
    face,
    folder: 'drafts',
    labels: [],
    draft: mail,
    messages: [
      {
        id: `${row.id}-1`,
        from: account?.name ?? 'Me',
        email: account?.email ?? '',
        to: recipients.join(', ') || 'no recipients',
        face,
        time: formatTime(row.updated_at, now),
        paragraphs: [],
        markdown: mail.body.trim() ? mail.body : '_(empty message)_',
        attachments: mail.attachments?.length ? mail.attachments : undefined,
      },
    ],
  }
}

const firstLine = (body: string) =>
  body
    .split('\n')
    .map((l) => l.replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+)/, '').trim())
    .find((l) => l.length > 0) ?? ''

function toThread(accountId: string, id: string, rows: Row[], folder: FolderId, now: Date, files?: Map<number, Attachment[]>): MailThread {
  const latest = rows.at(-1)!
  const messages = rows.map((row, index) => toMessage(id, row, index, now, files))
  const senders = [...new Set(rows.map((r) => r.from_name || r.from_email || '(unknown sender)'))]
  const sender = senders.length > 2 ? `${senders[0]} … ${senders.at(-1)}` : senders.join(', ')
  return {
    id,
    sender: rows.length > 1 ? `${sender} (${rows.length})` : sender,
    subject: rows[0]!.subject || '(no subject)',
    snippet: latest.snippet,
    // The newest message's code: an older one in the conversation has been used or has expired.
    ...(parseSignIn(latest.sign_in) ? { signIn: parseSignIn(latest.sign_in) } : {}),
    date: formatListDate(latest.date, now),
    at: latest.date,
    group: groupOf(latest.date, now),
    unread: rows.some((r) => r.seen === 0),
    starred: rows.some((r) => r.flagged === 1),
    icons: rows.some((r) => r.has_attachments) ? ['paperclip'] : [],
    // No priority model yet: everything in the inbox counts, so the default tab isn't empty.
    priority: folder === 'inbox',
    tag: FOLDER_TAGS[folder],
    face: messages.at(-1)!.face,
    folder,
    labels: [
      ...[...new Set(rows.flatMap((r) => (r.labels ? r.labels.split('\u001f') : [])))].sort().map((name) => gmailLabelId(accountId, name)),
      ...[...new Set(rows.flatMap((r) => (r.local_labels ? r.local_labels.split('\u001f') : [])))].sort(),
    ],
    messages,
  }
}

function toMessage(threadId: string, row: Row, index: number, now: Date, files?: Map<number, Attachment[]>): Message {
  const from = row.from_name || row.from_email || '(unknown sender)'
  const toAddresses = parse(row.to_json) as MailAddress[]
  const ccAddresses = parse(row.cc_json) as MailAddress[]
  const replyToAddresses = parse(row.reply_to_json) as MailAddress[]
  const recipients = [...toAddresses, ...ccAddresses]
  return {
    id: `${threadId}-${row.id}`,
    from,
    email: row.from_email ?? '',
    to: recipients.map((a) => a.name || a.email).join(', ') || 'undisclosed recipients',
    ...(row.from_email ? { fromAddress: { ...(row.from_name ? { name: row.from_name } : {}), email: row.from_email } } : {}),
    toAddresses,
    ccAddresses,
    replyToAddresses,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    references: JSON.parse(row.references_json) as string[],
    ...(row.list_unsubscribe ? { unsubscribe: parseUnsubscribe(row.list_unsubscribe, row.list_unsubscribe_post === 1) } : {}),
    face: withDemoFace(row.from_email ?? undefined, { letter: initialsOf(from) }),
    time: formatTime(row.date, now),
    timestamp: row.date,
    paragraphs: row.text ? paragraphsOf(row.text) : row.snippet ? [row.snippet] : [],
    // Only meaningful when bodies were loaded: the engine fetches these from the server on open.
    ...(row.has_body === null && files ? { bodyMissing: true } : {}),
    ...(files?.get(row.id)?.length ? { attachments: files.get(row.id) } : {}),
    // HTML mail is rebuilt as safe Markdown; the reader draws that instead of the plain-text part.
    ...(row.html ? { markdown: htmlToMarkdown(row.html), html: row.html } : {}),
  }
}

const TONES: LabelTone[] = ['purple', 'green', 'blue', 'amber', 'pink', 'teal']

/**
 * The account's labels for the UI: on Gmail, every user label folder on the server plus any label
 * seen on a message (colors stable per name); then the labels Jefi keeps itself (local-labels.ts),
 * which is all a non-Gmail account has.
 */
export function loadLabels(db: MailDatabase, accountId: string): Label[] {
  const local = listLocalLabels(db, accountId)
  if (!isGmailAccount(db, accountId)) return local
  const names = new Set<string>()
  const folders = db.query("SELECT path FROM mailboxes WHERE account_id = ? AND special_use IS NULL AND upper(path) <> 'INBOX' AND path NOT LIKE '[Gmail]%'").all(accountId) as Array<{ path: string }>
  for (const f of folders) names.add(f.path)
  const used = db.query('SELECT DISTINCT ml.label FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.account_id = ?').all(accountId) as Array<{ label: string }>
  for (const u of used) names.add(u.label)
  const gmail = [...names].sort().map((name): Label => ({ id: gmailLabelId(accountId, name), label: name, color: TONES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length]! }))
  return [...gmail, ...local]
}

/** Whether the account's server is Gmail, whose labels live on the server (X-GM-LABELS). */
export function isGmailAccount(db: MailDatabase, accountId: string): boolean {
  // Not gm_msgid: imapflow also fills that from OBJECTID on non-Gmail servers (e.g. Fastmail).
  return !!(
    db.query("SELECT 1 FROM mailboxes WHERE account_id = ? AND (path LIKE '[Gmail]/%' OR path LIKE '[Google Mail]/%') LIMIT 1").get(accountId) ??
    db.query('SELECT 1 FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.account_id = ? LIMIT 1').get(accountId)
  )
}

const FOLDER_TAGS: Record<FolderId, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  snoozed: 'Snoozed',
  outbox: 'Outbox',
  sent: 'Sent',
  drafts: 'Drafts',
  archive: 'Archive',
  spam: 'Spam',
  trash: 'Trash',
}

const parse = (json: string): Address[] => {
  try {
    return JSON.parse(json) as Address[]
  } catch {
    return []
  }
}

const initialsOf = (name: string) =>
  name
    .replace(/[<>"@].*$/, '')
    .split(/\s+/)
    .map((part) => part.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '')
    // Emoji and symbols are skipped: indexing a string could split an emoji in half.
    .filter(Boolean)
    .slice(0, 2)
    .join('') || '?'

const paragraphsOf = (text: string) =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
const DAY = 86_400_000

export function groupOf(time: number, now: Date): MailThread['group'] {
  const today = startOfDay(now)
  if (time >= today) return 'Today'
  if (time >= today - DAY) return 'Yesterday'
  if (time >= today - 6 * DAY) return 'Last 7 days'
  return 'Earlier'
}

// Built once: toLocale*String sets up a formatter per call, which was most of a page's cost.
const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const DAY_MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const DAY_CLOCK = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function formatListDate(time: number, now: Date) {
  const date = new Date(time)
  if (time >= startOfDay(now)) return CLOCK.format(date)
  if (date.getFullYear() === now.getFullYear()) return DAY_MONTH.format(date)
  return DAY_MONTH_YEAR.format(date)
}

const formatTime = (time: number, now: Date) => (time >= startOfDay(now) ? CLOCK : DAY_CLOCK).format(time)

/**
 * Files attached to the given messages (inline images referenced by the HTML excluded at sync, the
 * invitation's calendar part here). Each keeps its index among the stored parts, which is what
 * getAttachment downloads by.
 */
function attachmentsOf(db: MailDatabase, ids: number[]): Map<number, Attachment[]> {
  const byMessage = new Map<number, Attachment[]>()
  if (!ids.length) return byMessage
  const rows = db
    .query(`SELECT a.message_id, a.filename, a.content_type, a.size, ${INVITE_PART_SQL} AS invite FROM attachments a WHERE a.message_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.id`)
    .all(...ids) as Array<{ message_id: number; filename: string | null; content_type: string | null; size: number | null; invite: number }>
  const stored = new Map<number, number>()
  for (const row of rows) {
    const index = stored.get(row.message_id) ?? 0
    stored.set(row.message_id, index + 1)
    if (row.invite) continue
    const name = row.filename || `Untitled.${(row.content_type ?? 'application/octet-stream').split('/')[1]?.split(/[;+]/)[0] || 'bin'}`
    byMessage.set(row.message_id, [...(byMessage.get(row.message_id) ?? []), { name, size: formatSize(row.size ?? 0), index }])
  }
  return byMessage
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Folders servers expose over IMAP that don't hold mail people file (Exchange/Outlook.com). */
const NOT_MAIL_FOLDERS = new Set(['notes', 'outbox', 'calendar', 'contacts', 'tasks', 'journal', 'conversation history', 'sync issues', 'rss feeds', 'rss subscriptions'])

/**
 * The account's plain IMAP folders (no special use: not Inbox, Sent, Trash…), for the sidebar.
 * Gmail's are its labels, which have their own section.
 */
export function loadFolders(db: MailDatabase, accountId: string): MailFolder[] {
  const gmail = db.query("SELECT 1 FROM mailboxes WHERE account_id = ? AND (path LIKE '[Gmail]/%' OR path LIKE '[Google Mail]/%') LIMIT 1").get(accountId)
  if (gmail) return []
  const rows = db
    .query('SELECT path, delimiter FROM mailboxes WHERE account_id = ? AND special_use IS NULL ORDER BY path COLLATE NOCASE')
    .all(accountId) as Array<{ path: string; delimiter: string | null }>
  return rows.filter(({ path }) => !NOT_MAIL_FOLDERS.has(path.toLowerCase())).map(({ path, delimiter }) => {
    const parts = delimiter ? path.split(delimiter) : [path]
    // Servers that nest everything under INBOX (INBOX.Projects) read better without the prefix.
    if (parts.length > 1 && parts[0]!.toUpperCase() === 'INBOX') parts.shift()
    return { path, name: parts.at(-1)!, depth: parts.length - 1 }
  })
}
