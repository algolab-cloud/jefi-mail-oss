import { createHash } from 'node:crypto'
import { accessSync, constants, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { MailDatabase } from './db'
import { uiThreadId } from './threading'

export type AttachmentTarget = {
  accountDirectory: string
  rowId: number
  index: number
  name: string
  /** Exact decoded size, checked against the downloaded bytes; null when unknown or only estimated. */
  size: number | null
  mailbox: string
  uid: number
  uidvalidity: number
  path: string
}

const accountKey = (accountId: string) => createHash('sha256').update(accountId).digest('hex')

export const attachmentAccountDirectory = (root: string, accountId: string) => join(root, accountKey(accountId))

export function safeAttachmentName(filename: string | null, index: number): string {
  const leaf = (filename ?? '').split(/[/\\]/).pop()!.replace(/[\u0000-\u001f\u007f:]/g, '_').replace(/^\.+/, '').trim()
  const fallback = `attachment-${index + 1}`
  if (!leaf) return fallback

  let safe = ''
  for (const character of leaf) {
    if (Buffer.byteLength(safe + character) > 180) break
    safe += character
  }
  return safe || fallback
}

/** Resolve and authorize one stable reader attachment index without touching the network. */
export function resolveAttachmentTarget(
  db: MailDatabase,
  root: string,
  accountId: string,
  messageId: string,
  index: number,
): AttachmentTarget | null {
  if (!Number.isSafeInteger(index) || index < 0) return null
  const suffix = messageId.match(/-(\d+)$/)
  if (!suffix) return null
  const rowId = Number(suffix[1])
  if (!Number.isSafeInteger(rowId) || rowId < 1) return null

  const row = db
    .query(
      `SELECT m.id, m.thread_id, a.filename, a.size, a.size_estimated
       FROM messages m JOIN attachments a ON a.message_id = m.id
       WHERE m.id = ? AND m.account_id = ?
       ORDER BY a.id LIMIT 1 OFFSET ?`,
    )
    .get(rowId, accountId, index) as {
      id: number
      thread_id: string | null
      filename: string | null
      size: number | null
      size_estimated: number
    } | null
  if (!row) return null

  const source = db
    .query(
      `SELECT mb.path AS mailbox, mb.uidvalidity, mm.uid
       FROM message_mailboxes mm
       JOIN mailboxes mb ON mb.id = mm.mailbox_id
       WHERE mm.message_id = ? AND mb.account_id = ? AND mm.uid > 0
       ORDER BY CASE WHEN mb.special_use = '\\Inbox' THEN 0 ELSE 1 END, mb.path
       LIMIT 1`,
    )
    .get(rowId, accountId) as { mailbox: string; uidvalidity: number | null; uid: number } | null
  if (!source || source.uidvalidity === null) return null

  const expectedMessageId = `${uiThreadId(accountId, row.thread_id, row.id)}-${row.id}`
  if (messageId !== expectedMessageId) return null
  const accountDirectory = attachmentAccountDirectory(root, accountId)
  // Both SQLite row ids and IMAP UIDs can be reused. UIDVALIDITY is the server's namespace for a
  // UID, so all four values must remain stable before bytes from this cache can be returned.
  const binding = `${messageId}\0${source.mailbox}\0${source.uidvalidity}\0${source.uid}`
  const messageDirectory = `${rowId}-${createHash('sha256').update(binding).digest('hex').slice(0, 16)}`
  const name = safeAttachmentName(row.filename, index)
  return {
    accountDirectory,
    rowId,
    index,
    name,
    // Only an exact size can vouch for the downloaded bytes; an estimate (from BODYSTRUCTURE) can't.
    size: row.size_estimated ? null : row.size,
    mailbox: source.mailbox,
    uid: source.uid,
    uidvalidity: source.uidvalidity,
    path: join(accountDirectory, messageDirectory, String(index), name),
  }
}

/** Compare the complete authorized server identity before publishing downloaded bytes. */
export const sameAttachmentTarget = (left: AttachmentTarget, right: AttachmentTarget) =>
  left.rowId === right.rowId
  && left.index === right.index
  && left.name === right.name
  && left.size === right.size
  && left.mailbox === right.mailbox
  && left.uid === right.uid
  && left.uidvalidity === right.uidvalidity
  && left.path === right.path

/**
 * Once an attachment is downloaded its exact size is known: it replaces the estimate (see
 * fetchTextBodies in sync.ts), so later cache hits are checked against it.
 */
export function settleAttachmentSize(db: MailDatabase, target: AttachmentTarget, size: number) {
  db.run(
    `UPDATE attachments SET size = ?, size_estimated = 0
     WHERE size_estimated = 1 AND id = (SELECT id FROM attachments WHERE message_id = ? ORDER BY id LIMIT 1 OFFSET ?)`,
    [size, target.rowId, target.index],
  )
}

/** A cache hit must be a readable regular file and still match the server-announced size. */
export function hasReadableCachedAttachment(target: AttachmentTarget): boolean {
  try {
    const info = lstatSync(target.path)
    accessSync(target.path, constants.R_OK)
    return info.isFile() && (target.size === null || info.size === target.size)
  } catch {
    return false
  }
}

export const clearAttachmentCache = (root: string, accountId: string) =>
  rmSync(attachmentAccountDirectory(root, accountId), { recursive: true, force: true })
