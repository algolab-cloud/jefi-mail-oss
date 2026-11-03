import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ImapFlow } from 'imapflow'
import { hasReadableCachedAttachment, resolveAttachmentTarget, sameAttachmentTarget, type AttachmentTarget } from './attachment-cache'
import { openDatabase } from './db'
import { downloadAttachment } from './sync'
import { rawMessage } from './testing/imap-server'

const target = (directory: string, overrides: Partial<AttachmentTarget> = {}): AttachmentTarget => ({
  accountDirectory: directory,
  rowId: 1,
  index: 0,
  name: 'report.txt',
  size: 6,
  mailbox: 'INBOX',
  uid: 7,
  uidvalidity: 42,
  path: join(directory, '1-bound', '0', 'report.txt'),
  ...overrides,
})

test('attachment download is bounded and preserves the exact indexed attachment', async () => {
  const directory = mkdtempSync(`${tmpdir()}/jefi-attachment-bound-`)
  const raw = rawMessage({
    n: 1,
    attachments: [
      { filename: 'report.txt', content: 'first!' },
      { filename: 'report.txt', content: 'second' },
    ],
  })
  const calls: Array<{ range: string; options: Record<string, unknown> }> = []
  let released = false
  const client = {
    mailbox: { uidValidity: 42n },
    getMailboxLock: async () => ({ release: () => { released = true } }),
    download: async (range: string, _part: undefined, options: Record<string, unknown>) => {
      calls.push({ range, options })
      return { meta: { expectedSize: Buffer.byteLength(raw) }, content: Readable.from([Buffer.from(raw)]) }
    },
  } as unknown as ImapFlow
  const selected = target(directory, { index: 1, path: join(directory, '1-bound', '1', 'report.txt') })
  try {
    expect(await downloadAttachment(client, selected, Buffer.byteLength(raw))).toBe(selected.path)
    expect(readFileSync(selected.path, 'utf8')).toBe('second')
    expect(calls).toEqual([{ range: '7', options: { uid: true, maxBytes: Buffer.byteLength(raw) + 1, chunkSize: 64 * 1024 } }])
    expect(released).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('attachment download rejects a UID reused after UIDVALIDITY changes during the fetch', async () => {
  const directory = mkdtempSync(`${tmpdir()}/jefi-attachment-uid-`)
  const raw = rawMessage({ n: 1, attachment: { filename: 'report.txt', content: 'report' } })
  const mailbox = { uidValidity: 42n }
  async function* changedSource() {
    yield Buffer.from(raw)
    mailbox.uidValidity = 43n
  }
  const client = {
    mailbox,
    getMailboxLock: async () => ({ release: () => {} }),
    download: async () => ({ meta: { expectedSize: Buffer.byteLength(raw) }, content: Readable.from(changedSource()) }),
  } as unknown as ImapFlow
  try {
    await expect(downloadAttachment(client, target(directory))).rejects.toThrow('changed on the server')
    expect(existsSync(target(directory).path)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('attachment download rejects a lying oversized source and leaves no cache file', async () => {
  const directory = mkdtempSync(`${tmpdir()}/jefi-attachment-oversized-`)
  const stream = Readable.from([Buffer.from('1234'), Buffer.from('5678')])
  let released = false
  const client = {
    mailbox: { uidValidity: 42n },
    getMailboxLock: async () => ({ release: () => { released = true } }),
    download: async () => ({ meta: { expectedSize: 1 }, content: stream }),
  } as unknown as ImapFlow
  try {
    await expect(downloadAttachment(client, target(directory), 5)).rejects.toThrow('too large')
    expect(existsSync(target(directory).path)).toBe(false)
    expect(stream.destroyed).toBe(true)
    expect(released).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('attachment cache identity changes with mailbox UIDVALIDITY and never returns old bytes', () => {
  const directory = mkdtempSync(`${tmpdir()}/jefi-attachment-cache-`)
  const db = openDatabase(':memory:')
  try {
    db.run("INSERT INTO accounts (id, email, created_at) VALUES ('account', 'me@example.com', 1)")
    db.run("INSERT INTO mailboxes (id, account_id, path, special_use, uidvalidity) VALUES (1, 'account', 'INBOX', '\\Inbox', 42)")
    db.run("INSERT INTO messages (id, account_id, thread_id, date) VALUES (1, 'account', 'thread', 1)")
    db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (1, 7, 1)')
    db.run("INSERT INTO attachments (message_id, filename, size) VALUES (1, 'report.txt', 6)")

    const before = resolveAttachmentTarget(db, directory, 'account', 'account:thread-1', 0)!
    mkdirSync(dirname(before.path), { recursive: true })
    writeFileSync(before.path, 'secret')
    expect(hasReadableCachedAttachment(before)).toBe(true)

    db.run('UPDATE mailboxes SET uidvalidity = 43 WHERE id = 1')
    const after = resolveAttachmentTarget(db, directory, 'account', 'account:thread-1', 0)!
    expect(sameAttachmentTarget(before, after)).toBe(false)
    expect(after.path).not.toBe(before.path)
    expect(hasReadableCachedAttachment(after)).toBe(false)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
