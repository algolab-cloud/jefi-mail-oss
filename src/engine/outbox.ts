import { Transform } from 'node:stream'
import type { ImapFlow } from 'imapflow'
import type { Transporter } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { Account } from '../accounts'
import type { DraftFields } from '../data'
import { fileProblemMessage, readProblem, type FileProblem } from '../attachment-files'
import type { MailDatabase } from './db'
import type { OutgoingCalendar, OutgoingMessage, ReplyHeaders } from './mime'

// ---------------------------------------------------------------------------
// The outbox: every send is an immutable snapshot in outbound_queue before anything touches SMTP.
// States: queued → sending → sent | failed. A send is never repeated unless it certainly didn't go:
// once the whole body has been handed to the server (body_sent_at), only the server's reply says
// whether it was accepted. If that reply never comes (a dropped connection, a timeout, a crash or
// quit mid-send) the send is unconfirmed: failed, with no automatic retry, until the person says
// it was sent or sends it again, or its copy turns up in Sent (reconcileSentCopies).
// ---------------------------------------------------------------------------

export type OutboxKind = 'message' | 'reply'

export type OutboxEntry = {
  id: string
  accountId: string
  kind: OutboxKind
  /** UI thread the message belongs to (the outbox thread, or the thread being replied to). */
  threadId: string
  mail: DraftFields
  messageId: string
  reply?: ReplyHeaders
  /** Set for invitations, cancellations and replies to invitations (calendar/invites.ts). */
  calendar?: OutgoingCalendar
  state: 'queued' | 'sending' | 'sent' | 'failed'
  attempts: number
  lastError: string | null
  nextAttemptAt: number | null
  createdAt: number
  updatedAt: number
  permanent: boolean
  retryStopped: boolean
  /** The server may have accepted it: the body went out and no reply came back. Never retried automatically. */
  unconfirmed: boolean
}

type Row = {
  id: string
  account_id: string
  mail_json: string
  state: OutboxEntry['state']
  attempts: number
  last_error: string | null
  next_attempt_at: number | null
  failure_kind: 'temporary' | 'permanent' | 'exhausted' | null
  body_sent_at: number | null
  created_at: number
  updated_at: number
}

type Payload = { kind: OutboxKind; threadId: string; mail: DraftFields; messageId: string; reply?: ReplyHeaders; calendar?: OutgoingCalendar }

const toEntry = (row: Row): OutboxEntry => {
  const payload = JSON.parse(row.mail_json) as Payload
  return {
    id: row.id,
    accountId: row.account_id,
    ...payload,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Stored as a permanent failure too, so an older build that doesn't know the column won't retry it.
    unconfirmed: row.state === 'failed' && row.body_sent_at !== null,
    permanent: row.state === 'failed' && row.failure_kind === 'permanent' && row.body_sent_at === null,
    retryStopped: row.state === 'failed' && row.failure_kind === 'exhausted',
  }
}

/** `sendAt` schedules the message (send later); without it the message goes on the next drain. */
export function enqueueOutgoing(db: MailDatabase, entry: { id: string; accountId: string; sendAt?: number } & Payload) {
  const now = Date.now()
  const payload: Payload = { kind: entry.kind, threadId: entry.threadId, mail: structuredClone(entry.mail), messageId: entry.messageId, reply: entry.reply, ...(entry.calendar ? { calendar: entry.calendar } : {}) }
  db.run(
    `INSERT INTO outbound_queue (id, account_id, mail_json, in_reply_to, state, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET mail_json = excluded.mail_json, state = 'queued', attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, failure_kind = NULL, body_sent_at = NULL, updated_at = excluded.updated_at
     WHERE outbound_queue.state IN ('queued', 'failed')`,
    [entry.id, entry.accountId, JSON.stringify(payload), entry.reply?.inReplyTo ?? null, entry.sendAt ?? null, now, now],
  )
}

export function getOutgoing(db: MailDatabase, id: string): OutboxEntry | null {
  const row = db.query('SELECT * FROM outbound_queue WHERE id = ?').get(id) as Row | null
  return row ? toEntry(row) : null
}

/** Messages and replies that still need attention, including scheduled and failed entries. */
export function listOutgoing(db: MailDatabase, accountId: string): OutboxEntry[] {
  return (db
    .query("SELECT * FROM outbound_queue WHERE account_id = ? AND state <> 'sent' ORDER BY created_at DESC")
    .all(accountId) as Row[]).map(toEntry)
}

/** Reconcile attempted sends only against our own copy in the server's Sent mailbox. */
export function reconcileSentCopies(db: MailDatabase, accountId: string): string[] {
  const delivered: string[] = []
  const exists = db.query(`
    SELECT 1 FROM messages m
    JOIN accounts a ON a.id = m.account_id
    JOIN message_mailboxes mm ON mm.message_id = m.id
    JOIN mailboxes mb ON mb.id = mm.mailbox_id AND mb.account_id = m.account_id
    WHERE m.account_id = ? AND m.message_id = ?
      AND lower(m.from_email) = lower(a.email) AND mb.special_use = '\\Sent'
    LIMIT 1`)
  for (const entry of listOutgoing(db, accountId)) {
    if (entry.attempts === 0) continue
    if (!exists.get(accountId, entry.messageId)) continue
    markSent(db, entry.id)
    delivered.push(entry.id)
  }
  return delivered
}

/** Rows ready to send for an account: queued, or failed temporarily and due for a retry. */
export function dueOutgoing(db: MailDatabase, accountId: string, now = Date.now()): OutboxEntry[] {
  return (
    db
      .query(
        `SELECT * FROM outbound_queue WHERE account_id = ?1
           AND ((state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?2))
                OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?2))
         ORDER BY created_at`,
      )
      .all(accountId, now) as Row[]
  ).map(toEntry)
}

export function markSending(db: MailDatabase, id: string): boolean {
  return db.run("UPDATE outbound_queue SET state = 'sending', attempts = attempts + 1, failure_kind = NULL, body_sent_at = NULL, updated_at = ? WHERE id = ? AND state IN ('queued', 'failed')", [Date.now(), id]).changes === 1
}

/** The whole body has gone to the server: from here a lost reply leaves the send unconfirmed. */
export function markBodySent(db: MailDatabase, id: string) {
  db.run("UPDATE outbound_queue SET body_sent_at = ? WHERE id = ? AND state = 'sending'", [Date.now(), id])
}

export function markSent(db: MailDatabase, id: string) {
  db.run("UPDATE outbound_queue SET state = 'sent', last_error = NULL, next_attempt_at = NULL, failure_kind = NULL, body_sent_at = NULL, updated_at = ? WHERE id = ?", [Date.now(), id])
}

/** The server may have it: kept out of the retry schedule until the person decides. */
export function markUnconfirmed(db: MailDatabase, id: string, error: string) {
  db.run(
    "UPDATE outbound_queue SET state = 'failed', last_error = ?, next_attempt_at = NULL, failure_kind = 'permanent', body_sent_at = coalesce(body_sent_at, ?), updated_at = ? WHERE id = ?",
    [error, Date.now(), Date.now(), id],
  )
}

/** The person says an unconfirmed message did go out. The entry, or null if it isn't one. */
export function markConfirmedSent(db: MailDatabase, accountId: string, id: string, expectedThreadId?: string): OutboxEntry | null {
  const entry = getOutgoing(db, id)
  if (!entry || entry.accountId !== accountId || !entry.unconfirmed || (expectedThreadId !== undefined && entry.threadId !== expectedThreadId)) return null
  markSent(db, id)
  return entry
}

export function markFailed(
  db: MailDatabase,
  id: string,
  error: string,
  retryAt: number | null,
  kind: 'temporary' | 'permanent' | 'exhausted' = retryAt === null ? 'permanent' : 'temporary',
) {
  // The server answered (or was never reached), so the outcome is known: not sent.
  db.run("UPDATE outbound_queue SET state = 'failed', last_error = ?, next_attempt_at = ?, failure_kind = ?, body_sent_at = NULL, updated_at = ? WHERE id = ?", [error, retryAt, kind, Date.now(), id])
}

/** Queue a failed message again right now (manual retry). */
export function requeue(db: MailDatabase, accountId: string, id: string, expectedThreadId?: string): boolean {
  const entry = getOutgoing(db, id)
  if (!entry || entry.accountId !== accountId || (expectedThreadId !== undefined && entry.threadId !== expectedThreadId)) return false
  return db.run("UPDATE outbound_queue SET state = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL, failure_kind = NULL, body_sent_at = NULL, updated_at = ? WHERE id = ? AND account_id = ? AND state = 'failed'", [Date.now(), id, accountId]).changes === 1
}

/** Remove a message that hasn't started sending. False once it's in flight or already sent. */
export function cancelOutgoing(db: MailDatabase, accountId: string, id: string): boolean {
  const row = db.query('SELECT account_id, state FROM outbound_queue WHERE id = ?').get(id) as { account_id: string; state: string } | null
  if (!row) return true
  if (row.account_id !== accountId) return false
  if (row.state === 'sending' || row.state === 'sent') return false
  db.run('DELETE FROM outbound_queue WHERE id = ? AND account_id = ?', [id, accountId])
  return true
}

export const INTERRUPTED_AFTER_BODY = 'Jefi Mail stopped before the server confirmed it'

/**
 * At startup: anything still 'sending' was cut off mid-flight. Before its body went out it goes back
 * to the queue; after, the server may have accepted it, so it waits for the person instead.
 */
export function recoverInterrupted(db: MailDatabase): number {
  const now = Date.now()
  const unconfirmed = db.run(
    "UPDATE outbound_queue SET state = 'failed', last_error = ?, next_attempt_at = NULL, failure_kind = 'permanent', updated_at = ? WHERE state = 'sending' AND body_sent_at IS NOT NULL",
    [INTERRUPTED_AFTER_BODY, now],
  ).changes
  return unconfirmed + db.run("UPDATE outbound_queue SET state = 'queued', failure_kind = NULL, updated_at = ? WHERE state = 'sending'", [now]).changes
}

// --- Delivery helpers ---------------------------------------------------------------------------

export type SmtpFailure = { permanent: boolean; message: string }

/** The SMTP reply code a failure carries, or 0 when the server never answered (a dropped connection or timeout). */
export function smtpReplyCode(err: unknown): number {
  const e = err as { responseCode?: number; response?: string; message?: string }
  const message = (e?.response || e?.message || String(err)).trim()
  return e?.responseCode ?? Number(message.match(/^\s*(\d{3})\b/)?.[1] ?? 0)
}

/**
 * A send whose whole body went out and that then failed without a reply may have been accepted:
 * the server's 250 can be lost on the way back. Sending it again could deliver it twice.
 */
export const sendOutcomeUnknown = (err: unknown, bodySent: boolean) => bodySent && smtpReplyCode(err) === 0

/**
 * Calls `handedOver` once a message's whole body has passed to SMTP, before the end-of-data mark
 * that lets the server accept it: until then a failure certainly means it wasn't sent. Messages go
 * through one at a time, so `handedOver` is read when each one starts streaming.
 */
export function watchBodySent(transport: Pick<Transporter, 'use'>, handedOver: () => (() => void) | null) {
  transport.use('stream', (mail, done) => {
    const notify = handedOver()
    // Never expected, but with nothing to watch the safe assumption is that the body may have gone.
    if (!mail.message) {
      notify?.()
      return done()
    }
    mail.message.transform(
      new Transform({
        transform: (chunk, _encoding, callback) => callback(null, chunk),
        flush: (callback) => {
          notify?.()
          callback()
        },
      }),
    )
    done()
  })
}

/** 5xx replies and rejected sign-ins won't fix themselves; everything else is worth retrying. */
export function classifySmtpError(err: unknown): SmtpFailure {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string }
  const message = (e?.response || e?.message || String(err)).trim()
  const responseCode = smtpReplyCode(err)
  // An SMTP 4xx is explicitly temporary even when Nodemailer labels the stage EAUTH/EENVELOPE.
  if (responseCode >= 400 && responseCode < 500) return { permanent: false, message }
  if (
    e?.code === 'EAUTH'
    || (responseCode >= 500 && responseCode < 600)
    || (e?.code === 'EENVELOPE' && responseCode === 0)
  ) {
    return { permanent: true, message }
  }
  return { permanent: false, message }
}

/** Retry schedule for temporary failures: 1 min, 5 min, 15 min, then hourly. */
export const retryDelayMs = (attempts: number) => [60_000, 5 * 60_000, 15 * 60_000][attempts - 1] ?? 60 * 60_000

/** Initial attempt plus seven automatic retries (about four hours with the schedule above). */
export const MAX_AUTOMATIC_ATTEMPTS = 8

export const nextAutomaticRetryAt = (attempts: number, now = Date.now()): number | null =>
  attempts >= MAX_AUTOMATIC_ATTEMPTS ? null : now + retryDelayMs(attempts)

/** Providers whose SMTP server files sent mail in Sent by itself: appending a copy would duplicate it. */
export function serverFilesSentMail(account: Account) {
  const host = account.servers.smtpHost.toLowerCase()
  return (
    account.provider === 'gmail' ||
    account.provider === 'outlook' ||
    account.provider === 'zoho' ||
    ['gmail.com', 'googlemail.com', 'office365.com', 'outlook.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))
  )
}

/** Render the exact RFC 822 bytes that were sent, for the copy appended to Sent. */
export function renderRaw(message: OutgoingMessage): Promise<Buffer> {
  return new MailComposer({ ...nodemailerFields(message), bcc: undefined }).compile().build()
}

export function nodemailerFields(message: OutgoingMessage) {
  return {
    messageId: message.messageId,
    date: message.date,
    from: message.from,
    to: message.to,
    cc: message.cc.length ? message.cc : undefined,
    bcc: message.bcc.length ? message.bcc : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html || undefined,
    inReplyTo: message.inReplyTo,
    references: message.references,
    // MailComposer reads each path itself, so the SMTP send and the Sent copy carry the same parts.
    attachments: message.attachments?.length || message.calendar?.attach ? [...(message.attachments ?? []), ...calendarFile(message)] : undefined,
    ...(message.calendar
      ? { alternatives: [{ contentType: `text/calendar; charset=UTF-8; method=${message.calendar.method}`, content: message.calendar.ics }] }
      : {}),
  }
}

/** invite.ics for clients that only look at attachments; the same text as the text/calendar part. */
const calendarFile = (message: OutgoingMessage) =>
  message.calendar?.attach ? [{ filename: 'invite.ics', content: message.calendar.ics, contentType: 'application/ics' }] : []

/** The first attachment the send can't read, if any: a message can't go out without its files. */
export function unreadableAttachment(message: OutgoingMessage): { filename: string; problem: FileProblem } | null {
  for (const file of message.attachments ?? []) {
    const problem = readProblem(file.path)
    if (problem) return { filename: file.filename, problem }
  }
  return null
}

export const unreadableAttachmentError = (file: { filename: string; problem: FileProblem }) => fileProblemMessage(file.filename, file.problem)

export async function appendToSent(client: ImapFlow, sentPath: string, raw: Buffer, date: Date) {
  await client.append(sentPath, raw, ['\\Seen'], date)
}
