import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ImapFlow } from 'imapflow'
import type { MailDatabase } from './db'
import { uiThreadId } from './threading'

const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024
const MAX_ACCOUNT_CACHE_BYTES = 512 * 1024 * 1024

export type OriginalTarget = { rowId: number; mailbox: string; uid: number; uidvalidity: number; path: string }

const accountKey = (accountId: string) => createHash('sha256').update(accountId).digest('hex')
export const originalAccountDirectory = (root: string, accountId: string) => join(root, accountKey(accountId))

/** Resolve a UI message id to one server copy while proving it belongs to this account. */
export function resolveOriginalTarget(db: MailDatabase, root: string, accountId: string, messageId: string): OriginalTarget | null {
  const suffix = messageId.match(/-(\d+)$/)
  if (!suffix) return null
  const rowId = Number(suffix[1])
  if (!Number.isSafeInteger(rowId) || rowId < 1) return null
  const row = db
    .query(
      `SELECT m.id, m.thread_id, mb.path AS mailbox, mb.uidvalidity, mm.uid
         FROM messages m
         JOIN message_mailboxes mm ON mm.message_id = m.id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
        WHERE m.id = ? AND m.account_id = ? AND mb.account_id = ? AND mm.uid > 0
        ORDER BY CASE WHEN mb.special_use = '\\Inbox' THEN 0 ELSE 1 END, mb.path
        LIMIT 1`,
    )
    .get(rowId, accountId, accountId) as { id: number; thread_id: string | null; mailbox: string; uidvalidity: number | null; uid: number } | null
  if (!row || row.uidvalidity === null) return null
  const expected = `${uiThreadId(accountId, row.thread_id, row.id)}-${row.id}`
  if (messageId !== expected) return null
  // Bind the cache to the server identity as well as the UI id. SQLite can reuse a deleted row id,
  // and an IMAP UID can name different bytes after UIDVALIDITY changes.
  const bound = createHash('sha256').update(`${messageId}\0${row.mailbox}\0${row.uidvalidity}\0${row.uid}`).digest('hex').slice(0, 16)
  return { rowId, mailbox: row.mailbox, uid: row.uid, uidvalidity: row.uidvalidity, path: join(originalAccountDirectory(root, accountId), `${rowId}-${bound}.eml`) }
}

export function hasReadableOriginal(target: OriginalTarget): boolean {
  try {
    const info = lstatSync(target.path)
    accessSync(target.path, constants.R_OK)
    return info.isFile() && info.size > 0 && info.size <= MAX_ORIGINAL_BYTES
  } catch {
    return false
  }
}

const filesUnder = (directory: string): Array<{ path: string; size: number; modified: number }> => {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return filesUnder(path)
      if (!entry.isFile()) return []
      const info = statSync(path)
      return [{ path, size: info.size, modified: info.mtimeMs }]
    })
  } catch {
    return []
  }
}

/** Keep original source caching useful offline without allowing it to grow forever. */
export function pruneOriginalCache(accountDirectory: string, keepPath: string, maximum = MAX_ACCOUNT_CACHE_BYTES) {
  const files = filesUnder(accountDirectory).sort((a, b) => a.modified - b.modified)
  let total = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files) {
    if (total <= maximum) break
    if (file.path === keepPath) continue
    rmSync(file.path, { force: true })
    total -= file.size
  }
}

/** Fetch and cache the exact RFC 822 octets. Nothing parses or reserializes the message. */
export async function downloadOriginalMessage(client: ImapFlow, target: OriginalTarget, maximumBytes = MAX_ORIGINAL_BYTES): Promise<{ path: string; size: number }> {
  const lock = await client.getMailboxLock(target.mailbox, { readOnly: true })
  let content: Readable | undefined
  try {
    if (!client.mailbox || Number(client.mailbox.uidValidity) !== target.uidvalidity) throw new Error('This message changed on the server; sync and try again')
    const downloaded = await client.download(String(target.uid), undefined, { uid: true, maxBytes: maximumBytes + 1, chunkSize: 64 * 1024 })
    if (!downloaded?.content) throw new Error('This message is no longer on the server')
    content = downloaded.content
    if (downloaded.meta.expectedSize && downloaded.meta.expectedSize > maximumBytes) {
      downloaded.content.destroy()
      throw new Error('This message is too large to export')
    }
    mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 })
    const temporary = `${target.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    let size = 0
    try {
      for await (const value of downloaded.content) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        size += chunk.byteLength
        if (size > maximumBytes) {
          downloaded.content.destroy()
          throw new Error('This message is too large to export')
        }
        await file.writeFile(chunk)
      }
      if (downloaded.meta.expectedSize && size !== downloaded.meta.expectedSize) throw new Error('The server returned an incomplete message; try again')
      await file.sync()
      await file.close()
      if (size === 0) throw new Error('This message is no longer on the server')
      renameSync(temporary, target.path)
    } catch (error) {
      await file.close().catch(() => {})
      rmSync(temporary, { force: true })
      throw error
    }
    pruneOriginalCache(dirname(target.path), target.path)
    return { path: target.path, size }
  } finally {
    if (content && !content.destroyed) content.destroy()
    lock.release()
  }
}

export const clearOriginalCache = (root: string, accountId: string) =>
  rmSync(originalAccountDirectory(root, accountId), { recursive: true, force: true })
