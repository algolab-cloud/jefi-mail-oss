import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ImapFlow } from 'imapflow'
import { downloadOriginalMessage, type OriginalTarget } from './original-message'

const target = (directory: string): OriginalTarget => ({
  rowId: 1,
  mailbox: 'INBOX',
  uid: 7,
  uidvalidity: 42,
  path: join(directory, 'message.eml'),
})

test('original download rejects a lying oversized stream and leaves no partial cache file', async () => {
  const directory = mkdtempSync(`${tmpdir()}/jefi-original-bound-`)
  let released = false
  const stream = Readable.from([Buffer.from('1234'), Buffer.from('5678')])
  const client = {
    mailbox: { uidValidity: 42n },
    getMailboxLock: async () => ({ release: () => { released = true } }),
    download: async () => ({ meta: { expectedSize: 1 }, content: stream }),
  } as unknown as ImapFlow
  try {
    await expect(downloadOriginalMessage(client, target(directory), 5)).rejects.toThrow('too large')
    expect(existsSync(target(directory).path)).toBe(false)
    expect(stream.destroyed).toBe(true)
    expect(released).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('original download rejects a reused UID after UIDVALIDITY changed', async () => {
  const directory = mkdtempSync(`${tmpdir()}/jefi-original-uid-`)
  let downloaded = false
  let released = false
  const client = {
    mailbox: { uidValidity: 43n },
    getMailboxLock: async () => ({ release: () => { released = true } }),
    download: async () => {
      downloaded = true
      return { meta: {}, content: Readable.from([Buffer.from('replacement')]) }
    },
  } as unknown as ImapFlow
  try {
    await expect(downloadOriginalMessage(client, target(directory), 100)).rejects.toThrow('changed on the server')
    expect(downloaded).toBe(false)
    expect(released).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('original download never caches a truncated message as the exact source', async () => {
  const directory = mkdtempSync(`${tmpdir()}/jefi-original-truncated-`)
  const client = {
    mailbox: { uidValidity: 42n },
    getMailboxLock: async () => ({ release: () => {} }),
    download: async () => ({ meta: { expectedSize: 30 }, content: Readable.from([Buffer.from('short')]) }),
  } as unknown as ImapFlow
  try {
    await expect(downloadOriginalMessage(client, target(directory), 100)).rejects.toThrow('incomplete message')
    expect(existsSync(target(directory).path)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
