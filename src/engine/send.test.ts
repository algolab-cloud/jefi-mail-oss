import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleParser } from 'mailparser'
import type { DraftFields } from '../data'
import { openDatabase, type MailDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { buildOutgoing, markdownToHtml, replyReferences, replySubject } from './mime'
import {
  classifySmtpError,
  dueOutgoing,
  enqueueOutgoing,
  getOutgoing,
  INTERRUPTED_AFTER_BODY,
  markBodySent,
  markFailed,
  markSending,
  markUnconfirmed,
  MAX_AUTOMATIC_ATTEMPTS,
  nextAutomaticRetryAt,
  reconcileSentCopies,
  requeue,
  sendOutcomeUnknown,
  unreadableAttachment,
} from './outbox'
import type { SecretStore } from './secrets'
import { selfSignedCert, startFakeSmtp } from './testing/fake-servers'
import { USER, rawMessage, startImapServer } from './testing/imap-server'
import { loadThreads } from './threads'
import type { EngineEvent } from './types'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const cert = selfSignedCert()
type Smtp = Awaited<ReturnType<typeof startFakeSmtp>>

async function setup(opts: { provider?: 'imap' | 'gmail' | 'outlook' | 'zoho'; smtpPass?: string; db?: MailDatabase; inbox?: Array<{ raw: string }>; schedulerMs?: number; dataEnd?: 'accept' | 'drop' | 'reject' } = {}) {
  const imap = await startImapServer({
    INBOX: opts.inbox ?? [{ raw: rawMessage({ n: 1, subject: 'Planning', messageId: '<plan@example.com>', references: ['<kickoff@example.com>'] }) }],
    Sent: { 'special-use': '\\Sent', messages: [] },
  })
  const smtp = await startFakeSmtp({ cert, users: [{ user: USER.user, pass: opts.smtpPass ?? USER.pass }], dataEnd: opts.dataEnd })
  const db = opts.db ?? openDatabase(':memory:')
  const account = { ...imap.account, name: 'Mara Lin', provider: opts.provider ?? 'imap', servers: { ...imap.account.servers, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'ssl' as const } }
  cleanups.push(() => imap.close(), () => smtp.close())
  if (!opts.db) cleanups.push(() => db.close())
  const start = (engineAccount = account) => {
    const secrets: SecretStore = { get: async (id) => (id === account.id ? USER.pass : null), set: async () => {}, delete: async () => {} }
    const engine = createImapEngine({ database: () => db, secrets, wake: false, watch: false, schedulerMs: opts.schedulerMs, newMailDebounceMs: 30, connectOptions: { allowInvalidCerts: true, timeoutMs: 3000 } })
    const events: EngineEvent[] = []
    engine.subscribe((batch) => events.push(...batch))
    engine.setAccounts([engineAccount])
    cleanups.push(() => engine.dispose())
    return { engine, events }
  }
  const { engine, events } = start()
  return { imap, smtp, db, account, engine, events, start }
}

const waitFor = async <T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const value = await fn()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error('timed out')
}

const deliveries = (events: EngineEvent[], id: string) =>
  events.flatMap((e) => (e.type === 'outboxState' && e.threadId === id ? [e.state] : e.type === 'replyState' && e.messageId === id ? [e.state] : []))

const mail = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  to: ['kenji@example.com'],
  cc: [],
  bcc: [],
  subject: 'Lunch on Friday?',
  body: 'Hey **Kenji**,\n\nWant to grab lunch?\n- sushi\n- ramen\n\n> Friday works best\n\nMara',
  ...overrides,
})

async function sentFolder(imap: Awaited<ReturnType<typeof startImapServer>>) {
  const client = await imap.connect()
  try {
    const lock = await client.getMailboxLock('Sent', { readOnly: true })
    try {
      if (!client.mailbox || client.mailbox.exists === 0) return []
      return (await client.fetchAll('1:*', { envelope: true, flags: true })).map((m) => ({ subject: m.envelope!.subject, messageId: m.envelope!.messageId, flags: [...m.flags!] }))
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

/** The raw bytes of everything filed in Sent, for checking the copy carries the same parts. */
async function sentSources(imap: Awaited<ReturnType<typeof startImapServer>>) {
  const client = await imap.connect()
  try {
    const lock = await client.getMailboxLock('Sent', { readOnly: true })
    try {
      if (!client.mailbox || client.mailbox.exists === 0) return []
      return (await client.fetchAll('1:*', { source: true })).map((m) => m.source!)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

/** Two files on disk to attach: one plain text, one with bytes that are not valid UTF-8. */
function attachmentFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'jefi-attach-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const text = 'sushi or ramen\n'
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i))
  const notes = join(dir, 'notes.txt')
  const pixels = join(dir, 'pixels.bin')
  writeFileSync(notes, text)
  writeFileSync(pixels, bytes)
  return {
    dir,
    text,
    bytes,
    attachments: [
      { name: 'notes.txt', size: '15 B', path: notes },
      { name: 'pixels.bin', size: '256 B', path: pixels },
    ],
  }
}

describe('sending', () => {
  test('delivers text + html over SMTP, files a copy in Sent, and syncs it back', async () => {
    const { imap, smtp, db, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))

    const draft = mail({ cc: ['nora@example.com'], bcc: ['boss@example.com'] })
    engine.send(account.id, 'sent-1', draft)
    draft.subject = 'EDITED AFTER SEND' // the queued snapshot must not change

    await waitFor(() => deliveries(events, 'sent-1').includes('sent'))
    expect(deliveries(events, 'sent-1')).toEqual(['sending', 'sent'])
    expect(smtp.received.length).toBe(1)

    const parsed = await simpleParser(smtp.received[0]!)
    expect(parsed.subject).toBe('Lunch on Friday?')
    expect(parsed.from?.value).toEqual([{ name: 'Mara Lin', address: 'me@example.com' }])
    expect(parsed.to && !Array.isArray(parsed.to) ? parsed.to.text : '').toBe('kenji@example.com')
    expect(parsed.cc && !Array.isArray(parsed.cc) ? parsed.cc.text : '').toBe('nora@example.com')
    expect(smtp.received[0]).not.toContain('boss@example.com') // bcc is envelope-only
    expect(parsed.text).toContain('Want to grab lunch?')
    expect(parsed.html).toContain('<strong>Kenji</strong>')
    expect(parsed.html).toContain('<li>sushi</li>')
    expect(parsed.html).toContain('<blockquote>')
    expect(parsed.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/)
    expect(getOutgoing(db, 'sent-1')?.state).toBe('sent')

    const filed = await waitFor(async () => {
      const copies = await sentFolder(imap)
      return copies.length ? copies : undefined
    })
    expect(filed).toEqual([{ subject: 'Lunch on Friday?', messageId: parsed.messageId, flags: ['\\Seen'] }])

    await waitFor(() => loadThreads(db, account.id).some((t) => t.folder === 'sent' && t.subject === 'Lunch on Friday?'))
  })

  test('attached files travel with the message and with the copy filed in Sent', async () => {
    const { imap, smtp, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))

    const files = attachmentFiles()
    engine.send(account.id, 'sent-files', mail({ attachments: files.attachments }))
    await waitFor(() => deliveries(events, 'sent-files').includes('sent'))

    const delivered = await simpleParser(smtp.received[0]!)
    expect(delivered.attachments.map((a) => a.filename)).toEqual(['notes.txt', 'pixels.bin'])
    expect(delivered.attachments[0]!.content.toString()).toBe(files.text)
    expect(Buffer.compare(delivered.attachments[1]!.content, files.bytes)).toBe(0)
    expect(delivered.text).toContain('Want to grab lunch?')

    const filed = await waitFor(async () => {
      const copies = await sentSources(imap)
      return copies.length ? copies : undefined
    })
    const copy = await simpleParser(filed[0]!)
    expect(copy.attachments.map((a) => a.filename)).toEqual(['notes.txt', 'pixels.bin'])
    expect(copy.attachments[0]!.content.toString()).toBe(files.text)
    expect(Buffer.compare(copy.attachments[1]!.content, files.bytes)).toBe(0)
  })

  test('a file that has moved fails the send permanently and delivers nothing', async () => {
    const { imap, smtp, db, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))

    const files = attachmentFiles()
    rmSync(files.attachments[1]!.path)
    engine.send(account.id, 'sent-gone', mail({ attachments: files.attachments }))
    await waitFor(() => deliveries(events, 'sent-gone').includes('failed'))

    const failed = getOutgoing(db, 'sent-gone')!
    expect(failed.permanent).toBe(true)
    expect(failed.lastError).toBe("Couldn't read pixels.bin — it may have been moved or deleted")
    await Bun.sleep(300)
    expect(smtp.received.length).toBe(0)
    expect(await sentFolder(imap)).toEqual([])
  })

  // Running as root reads anything, so the mode says nothing about what a normal account can do.
  const unlessRoot = process.getuid?.() === 0 ? test.skip : test
  unlessRoot('a file Jefi may not read fails permanently and says how to allow it', async () => {
    const { imap, smtp, db, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))

    const files = attachmentFiles()
    const secret = files.attachments[0]!.path
    chmodSync(secret, 0o000)
    cleanups.push(() => chmodSync(secret, 0o600))
    engine.send(account.id, 'sent-denied', mail({ attachments: files.attachments }))
    await waitFor(() => deliveries(events, 'sent-denied').includes('failed'))

    const failed = getOutgoing(db, 'sent-denied')!
    expect(failed.permanent).toBe(true)
    expect(failed.lastError).toBe("Jefi isn't allowed to read notes.txt. Allow it in System Settings → Privacy & Security → Files and Folders, then send again.")
    await Bun.sleep(300)
    expect(smtp.received.length).toBe(0)
    expect(await sentFolder(imap)).toEqual([])
  })

  test('replies to the selected earlier message with its In-Reply-To and References', async () => {
    const selectedAt = new Date(Date.UTC(2026, 0, 1, 8, 30))
    const { smtp, db, account, engine, events } = await setup({
      inbox: [
        {
          raw: rawMessage({
            n: 1,
            subject: 'Planning',
            messageId: '<earlier@example.com>',
            references: ['<kickoff@example.com>'],
            date: selectedAt,
            extraHeaders: ['Cc: Reviewer <reviewer@example.com>', 'Reply-To: Planning Desk <planning@example.com>'],
          }),
        },
        { raw: rawMessage({ n: 2, subject: 'Re: Planning', messageId: '<latest@example.com>', references: ['<kickoff@example.com>', '<earlier@example.com>'] }) },
        { raw: rawMessage({ n: 3, subject: 'Other thread', messageId: '<other@example.com>' }) },
      ],
    })
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((t) => t.subject === 'Planning')!
    const selected = parent.messages.find((message) => message.messageId === '<earlier@example.com>')!
    expect(selected).toMatchObject({
      fromAddress: { name: 'Ada Lovelace', email: 'ada@example.com' },
      toAddresses: [{ name: 'Me', email: 'me@example.com' }],
      ccAddresses: [{ name: 'Reviewer', email: 'reviewer@example.com' }],
      replyToAddresses: [{ name: 'Planning Desk', email: 'planning@example.com' }],
      timestamp: selectedAt.getTime(),
    })

    engine.sendReply(account.id, parent.id, 'reply-1', { to: ['ada@example.com'], cc: [], body: 'Sounds good.', parentMessageId: selected.id })
    await waitFor(() => deliveries(events, 'reply-1').includes('sent'))
    const parsed = await simpleParser(smtp.received.at(-1)!)
    expect(parsed.subject).toBe('Re: Planning')
    expect(parsed.inReplyTo).toBe('<earlier@example.com>')
    expect(parsed.references).toEqual(['<kickoff@example.com>', '<earlier@example.com>'])
    const reply = events.find((e) => e.type === 'replyState' && e.state === 'sent')
    expect(reply).toMatchObject({ threadId: parent.id, messageId: 'reply-1' })

    const other = loadThreads(db, account.id).find((thread) => thread.subject === 'Other thread')!
    const received = smtp.received.length
    engine.sendReply(account.id, parent.id, 'reply-wrong-thread', {
      to: ['ada@example.com'],
      cc: [],
      body: 'This must not be sent.',
      parentMessageId: other.messages[0]!.id,
    })
    expect(events.at(-1)).toMatchObject({ type: 'replyState', messageId: 'reply-wrong-thread', state: 'failed' })
    await Bun.sleep(50)
    expect(smtp.received.length).toBe(received)
  })

  test('a reply from the full composer keeps its Bcc and its edited subject', async () => {
    const { smtp, db, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((t) => t.subject === 'Planning')!
    engine.sendReply(account.id, parent.id, 'reply-bcc', { to: ['ada@example.com'], cc: [], bcc: ['boss@example.com'], subject: 'Re: Planning (dates)', body: 'Noted.', parentMessageId: parent.messages[0]!.id })
    await waitFor(() => deliveries(events, 'reply-bcc').includes('sent'))
    const parsed = await simpleParser(smtp.received.at(-1)!)
    expect(parsed.subject).toBe('Re: Planning (dates)')
    expect(parsed.inReplyTo).toBe('<plan@example.com>')
    expect(smtp.envelopes.at(-1)).toEqual(['ada@example.com', 'boss@example.com'])
    expect(smtp.received.at(-1)).not.toContain('boss@example.com')
  })

  test('a reply waits out the undo window: Undo keeps it from going, otherwise it goes when the window closes', async () => {
    const { smtp, db, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((t) => t.subject === 'Planning')!
    const before = smtp.received.length

    engine.sendReply(account.id, parent.id, 'reply-undone', { to: ['ada@example.com'], cc: [], body: 'Oops.' }, Date.now() + 300)
    expect(await engine.cancelSend(account.id, 'reply-undone')).toBe(true)
    engine.sendReply(account.id, parent.id, 'reply-kept', { to: ['ada@example.com'], cc: [], body: 'Meant it.' }, Date.now() + 300)
    await Bun.sleep(100)
    expect(smtp.received.length).toBe(before)
    await waitFor(() => deliveries(events, 'reply-kept').includes('sent'))
    await Bun.sleep(200)
    expect(smtp.received.length).toBe(before + 1)
    expect(deliveries(events, 'reply-undone')).toEqual([])
    expect((await simpleParser(smtp.received.at(-1)!)).inReplyTo).toBe('<plan@example.com>')
  })

  test('a reply sent later or from a reopened draft still threads', async () => {
    const { smtp, db, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((t) => t.subject === 'Planning')!
    engine.send(account.id, 'draft-reply', mail({ subject: 'Re: Planning', replying: { threadId: parent.id, messageId: parent.messages[0]!.id } }))
    await waitFor(() => deliveries(events, 'draft-reply').includes('sent'))
    const parsed = await simpleParser(smtp.received.at(-1)!)
    expect(parsed.inReplyTo).toBe('<plan@example.com>')
    expect(parsed.references).toEqual(['<kickoff@example.com>', '<plan@example.com>'])
  })

  test('a reply sent from another account than its conversation still threads, and goes out from that one', async () => {
    const { smtp, db, account, engine: first } = await setup()
    first.dispose()
    // A second account (same servers here, so the fake SMTP takes it) the reply is written as.
    const other = { ...account, id: `${account.id}-work`, name: 'Mara at Work' }
    const secrets: SecretStore = { get: async () => USER.pass, set: async () => {}, delete: async () => {} }
    const engine = createImapEngine({ database: () => db, secrets, wake: false, watch: false, newMailDebounceMs: 30, connectOptions: { allowInvalidCerts: true, timeoutMs: 3000 } })
    const events: EngineEvent[] = []
    engine.subscribe((batch) => events.push(...batch))
    engine.setAccounts([account, other])
    cleanups.push(() => engine.dispose())
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.accountId === account.id && e.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((t) => t.subject === 'Planning')!

    // Its draft was saved under the conversation's account, then From changed.
    engine.saveDraft(account.id, 'draft-cross', mail({ subject: 'Re: Planning', replying: { threadId: parent.id } }))
    engine.send(other.id, 'draft-cross', mail({ subject: 'Re: Planning', replying: { threadId: parent.id }, from: other.id }))
    await waitFor(() => deliveries(events, 'draft-cross').includes('sent'))
    expect(events.some((e) => e.type === 'outboxState' && e.threadId === 'draft-cross' && e.accountId === other.id)).toBe(true)
    const parsed = await simpleParser(smtp.received.at(-1)!)
    expect(parsed.inReplyTo).toBe('<plan@example.com>')
    expect(parsed.from?.value[0]?.name).toBe('Mara at Work')
    // The draft it was written in is gone from the first account.
    expect(db.query("SELECT count(*) n FROM drafts WHERE id = 'draft-cross'").get()).toEqual({ n: 0 })
  })

  test('an explicitly selected message without an RFC Message-ID never falls back to the latest message', async () => {
    const withoutMessageId = rawMessage({ n: 1, subject: 'Planning' }).replace(/^Message-ID:.*\r\n/m, '')
    const { smtp, db, account, engine, events } = await setup({
      inbox: [
        { raw: withoutMessageId },
        { raw: rawMessage({ n: 2, subject: 'Re: Planning', messageId: '<latest@example.com>' }) },
      ],
    })
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((event) => event.type === 'syncState' && event.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((thread) => thread.subject === 'Planning')!
    const selected = parent.messages.find((message) => !message.messageId)!

    engine.sendReply(account.id, parent.id, 'reply-no-rfc-id', {
      to: ['ada@example.com'],
      cc: [],
      body: 'Reply to the selected message.',
      parentMessageId: selected.id,
    })
    await waitFor(() => deliveries(events, 'reply-no-rfc-id').includes('sent'))
    const parsed = await simpleParser(smtp.received.at(-1)!)
    expect(parsed.inReplyTo).toBeUndefined()
    expect(parsed.references).toBeUndefined()
  })

  test('Outlook files sent mail itself, so no copy is appended', async () => {
    const { imap, account, engine, events } = await setup({ provider: 'outlook' })
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    engine.send(account.id, 'sent-o', mail())
    await waitFor(() => deliveries(events, 'sent-o').includes('sent'))
    await Bun.sleep(400)
    expect(await sentFolder(imap)).toEqual([])
  })

  test('Gmail files sent mail itself, so no copy is appended', async () => {
    const { imap, account, engine, events } = await setup({ provider: 'gmail' })
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    engine.send(account.id, 'sent-g', mail())
    await waitFor(() => deliveries(events, 'sent-g').includes('sent'))
    await Bun.sleep(400)
    expect(await sentFolder(imap)).toEqual([])
  })

  test('Zoho files sent mail itself, so no duplicate copy is appended', async () => {
    const { imap, account, engine, events } = await setup({ provider: 'zoho' })
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    engine.send(account.id, 'sent-z', mail())
    await waitFor(() => deliveries(events, 'sent-z').includes('sent'))
    await Bun.sleep(400)
    expect(await sentFolder(imap)).toEqual([])
  })

  test('a rejected sign-in fails permanently and is not retried by later syncs', async () => {
    const { smtp, db, account, engine, events } = await setup({ smtpPass: 'different' })
    engine.send(account.id, 'sent-auth', mail())
    await waitFor(() => deliveries(events, 'sent-auth').includes('failed'))
    const failed = getOutgoing(db, 'sent-auth')!
    expect(failed.state).toBe('failed')
    expect(failed.permanent).toBe(true)

    engine.syncNow(account.id, false)
    await waitFor(() => events.some((e) => e.type === 'syncState' && e.state.status === 'idle'))
    await Bun.sleep(300)
    expect(deliveries(events, 'sent-auth')).toEqual(['sending', 'failed'])
    expect(smtp.received.length).toBe(0)
  })

  test('an unreachable server fails temporarily; manual retry sends it once', async () => {
    const { smtp, db, account, engine, events } = await setup()
    await smtp.close()
    engine.send(account.id, 'sent-down', mail())
    await waitFor(() => deliveries(events, 'sent-down').includes('failed'))
    const failed = getOutgoing(db, 'sent-down')!
    expect(failed.permanent).toBe(false)
    // Never reached the server, so it certainly wasn't sent: safe to retry.
    expect(failed.unconfirmed).toBe(false)
    expect(failed.messageId).toMatch(/^<.+>$/)
    expect(events.find((event) => event.type === 'outboxState' && event.threadId === 'sent-down' && event.state === 'failed')).toMatchObject({
      attempts: 1,
      permanent: false,
      retryStopped: false,
      nextRetryAt: expect.any(Number),
    })

    const back = await startFakeSmtp({ cert, users: [USER] })
    cleanups.push(() => back.close())
    const moved = { ...account, servers: { ...account.servers, smtpPort: back.port } }
    engine.setAccounts([moved])
    engine.retry(account.id, 'sent-down')
    await waitFor(() => deliveries(events, 'sent-down').includes('sent'))
    expect(back.received.length).toBe(1)
    expect((await simpleParser(back.received[0]!)).messageId).toBe(failed.messageId)
    expect(getOutgoing(db, 'sent-down')!.attempts).toBe(1)
  })

  test('a due temporary failure retries automatically after an engine restart', async () => {
    const { smtp, db, account, engine, events, start } = await setup({ schedulerMs: 20 })
    await smtp.close()
    engine.send(account.id, 'sent-restart-retry', mail({ subject: 'Keep this identity' }))
    await waitFor(() => deliveries(events, 'sent-restart-retry').includes('failed'))
    const failed = getOutgoing(db, 'sent-restart-retry')!

    // Simulate quitting before the retry, then reopening while its persisted deadline approaches.
    db.run('UPDATE outbound_queue SET next_attempt_at = ? WHERE id = ?', [Date.now() + 100, failed.id])
    engine.dispose()
    const back = await startFakeSmtp({ cert, users: [USER] })
    cleanups.push(() => back.close())
    const moved = { ...account, servers: { ...account.servers, smtpPort: back.port } }
    const restarted = start(moved)

    await waitFor(() => deliveries(restarted.events, failed.id).includes('sent'))
    expect(back.received).toHaveLength(1)
    expect((await simpleParser(back.received[0]!)).messageId).toBe(failed.messageId)
  })

  test('queued and failed outbox messages are restored in the first snapshot after restart', async () => {
    const { db, account, engine, start } = await setup()
    enqueueOutgoing(db, {
      id: 'scheduled-restored',
      accountId: account.id,
      kind: 'message',
      threadId: 'scheduled-restored',
      mail: mail({ subject: 'Scheduled survives' }),
      messageId: '<scheduled-restored@example.com>',
      sendAt: Date.now() + 60_000,
    })
    enqueueOutgoing(db, {
      id: 'failed-restored',
      accountId: account.id,
      kind: 'message',
      threadId: 'failed-restored',
      mail: mail({ subject: 'Failed survives' }),
      messageId: '<failed-restored@example.com>',
    })
    markSending(db, 'failed-restored')
    markFailed(db, 'failed-restored', '550 rejected', null, 'permanent')
    engine.dispose()

    const restarted = start()
    const snapshot = restarted.events.find((event) => event.type === 'threadsChanged')
    expect(snapshot?.type).toBe('threadsChanged')
    if (snapshot?.type !== 'threadsChanged') throw new Error('missing initial snapshot')
    expect(snapshot.upserts.find((thread) => thread.id === 'scheduled-restored')).toMatchObject({
      folder: 'outbox',
      sendState: 'queued',
      sendAttempts: 0,
      draft: { subject: 'Scheduled survives' },
    })
    expect(snapshot.upserts.find((thread) => thread.id === 'failed-restored')).toMatchObject({
      folder: 'outbox',
      sendState: 'failed',
      sendAttempts: 1,
      sendError: '550 rejected',
      sendPermanent: true,
      draft: { subject: 'Failed survives' },
    })
  })

  test('failed replies restore in their conversation or as an actionable Outbox fallback', async () => {
    const { db, account, engine, events, start } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((event) => event.type === 'syncState' && event.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((thread) => thread.subject === 'Planning')!
    const failedReply = {
      accountId: account.id,
      kind: 'reply' as const,
      mail: mail({ subject: 'Re: Planning', body: 'Persist this reply.' }),
      messageId: '<reply-restored@example.com>',
      reply: { inReplyTo: '<plan@example.com>', references: ['<plan@example.com>'] },
    }
    enqueueOutgoing(db, { ...failedReply, id: 'reply-restored', threadId: parent.id })
    markSending(db, 'reply-restored')
    markFailed(db, 'reply-restored', '421 try later', Date.now() + 60_000, 'temporary')
    enqueueOutgoing(db, { ...failedReply, id: 'reply-orphaned', threadId: 'missing-parent' })
    markSending(db, 'reply-orphaned')
    markFailed(db, 'reply-orphaned', '550 rejected', null, 'permanent')
    engine.dispose()

    const restarted = start()
    const snapshot = restarted.events.find((event) => event.type === 'threadsChanged')
    if (snapshot?.type !== 'threadsChanged') throw new Error('missing initial snapshot')
    expect(snapshot.upserts.find((thread) => thread.id === parent.id)?.messages.at(-1)).toMatchObject({
      id: 'reply-restored',
      markdown: 'Persist this reply.',
      status: 'failed',
    })
    expect(snapshot.upserts.find((thread) => thread.id === 'reply-orphaned')).toMatchObject({
      folder: 'outbox',
      sendState: 'failed',
      sendPermanent: true,
      draft: { body: 'Persist this reply.' },
    })
    const beforeRetry = getOutgoing(db, 'reply-restored')!
    expect(requeue(db, account.id, 'reply-restored', parent.id)).toBe(true)
    expect(getOutgoing(db, 'reply-restored')).toMatchObject({
      attempts: 0,
      messageId: beforeRetry.messageId,
      mail: beforeRetry.mail,
    })
    expect(await restarted.engine.cancelSend(account.id, 'reply-orphaned')).toBe(true)
    expect(getOutgoing(db, 'reply-orphaned')).toBeNull()
  })

  test('retrying an orphaned reply from its Outbox fallback preserves reply identity and sends it', async () => {
    const { smtp, db, account, engine, events } = await setup()
    enqueueOutgoing(db, {
      id: 'reply-orphan-retry',
      accountId: account.id,
      kind: 'reply',
      threadId: 'missing-parent',
      mail: mail({ subject: 'Re: Missing conversation', body: 'The persisted reply body.' }),
      messageId: '<stable-orphan-reply@example.com>',
      reply: {
        inReplyTo: '<missing-parent@example.com>',
        references: ['<root@example.com>', '<missing-parent@example.com>'],
      },
    })
    markSending(db, 'reply-orphan-retry')
    markFailed(db, 'reply-orphan-retry', '550 rejected before restart', null, 'permanent')
    expect(loadThreads(db, account.id).find((thread) => thread.id === 'reply-orphan-retry')).toMatchObject({
      folder: 'outbox',
      sendState: 'failed',
    })

    // The standalone Outbox action knows the queue id, not the missing original parent id.
    engine.retry(account.id, 'reply-orphan-retry')
    await waitFor(() => deliveries(events, 'reply-orphan-retry').includes('sent'))

    expect(smtp.received).toHaveLength(1)
    const parsed = await simpleParser(smtp.received[0]!)
    expect(parsed.messageId).toBe('<stable-orphan-reply@example.com>')
    expect(parsed.inReplyTo).toBe('<missing-parent@example.com>')
    expect(parsed.references).toEqual(['<root@example.com>', '<missing-parent@example.com>'])
    expect(parsed.text?.trim()).toBe('The persisted reply body.')
  })

  test('matching incoming mail cannot mark a failed send as delivered', async () => {
    const id = '<incoming-collision@example.com>'
    const { db, account, engine, events } = await setup({ inbox: [{ raw: rawMessage({ n: 61, messageId: id, fromEmail: USER.user }) }] })
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((event) => event.type === 'syncState' && event.state.status === 'idle'))
    enqueueOutgoing(db, { id: 'incoming-collision', accountId: account.id, kind: 'message', threadId: 'incoming-collision', mail: mail(), messageId: id })
    markSending(db, 'incoming-collision')
    markFailed(db, 'incoming-collision', 'connection closed', null, 'exhausted')
    expect(reconcileSentCopies(db, account.id)).toEqual([])
    expect(getOutgoing(db, 'incoming-collision')?.state).toBe('failed')
  })

  test('a synced server copy reconciles a pending reply without drawing a duplicate', async () => {
    const { imap, db, account, engine, events } = await setup()
    engine.syncNow(account.id, false)
    await waitFor(() => events.some((event) => event.type === 'syncState' && event.state.status === 'idle'))
    const parent = loadThreads(db, account.id).find((thread) => thread.subject === 'Planning')!
    enqueueOutgoing(db, {
      id: 'reply-accepted-before-response',
      accountId: account.id,
      kind: 'reply',
      threadId: parent.id,
      mail: mail({ subject: 'Re: Planning', body: 'The server already accepted this.' }),
      messageId: '<accepted-before-response@example.com>',
      reply: { inReplyTo: '<plan@example.com>', references: ['<plan@example.com>'] },
    })
    markSending(db, 'reply-accepted-before-response')
    markFailed(db, 'reply-accepted-before-response', 'connection closed', Date.now() + 60_000, 'temporary')
    imap.append('Sent', {
      raw: rawMessage({
        n: 50,
        fromName: account.name,
        fromEmail: account.email,
        subject: 'Re: Planning',
        messageId: '<accepted-before-response@example.com>',
        inReplyTo: '<plan@example.com>',
        references: ['<plan@example.com>'],
        text: 'The server already accepted this.',
      }),
      flags: ['\\Seen'],
    })

    engine.syncNow(account.id, false)
    await waitFor(() => getOutgoing(db, 'reply-accepted-before-response')?.state === 'sent')
    const restored = loadThreads(db, account.id).find((thread) => thread.id === parent.id)!
    expect(restored.messages.filter((message) => message.messageId === '<accepted-before-response@example.com>')).toHaveLength(1)
    expect(restored.messages.some((message) => message.id === 'reply-accepted-before-response')).toBe(false)
  })

  test('sending while offline queues it; going online and syncing delivers it', async () => {
    const { smtp, db, account, engine, events } = await setup()
    engine.setOffline(true)
    engine.send(account.id, 'sent-offline', mail())
    await waitFor(() => deliveries(events, 'sent-offline').includes('failed'))
    expect(smtp.received.length).toBe(0)

    engine.setOffline(false)
    engine.syncNow(account.id, false)
    await waitFor(() => deliveries(events, 'sent-offline').includes('sent'))
    expect(smtp.received.length).toBe(1)
    expect(getOutgoing(db, 'sent-offline')!.state).toBe('sent')
  })

  test('cancel removes a queued message; one already sending cannot be cancelled', async () => {
    const { smtp, db, account, engine } = await setup()
    engine.setOffline(true)
    engine.send(account.id, 'sent-cancel', mail())
    expect(await engine.cancelSend(account.id, 'sent-cancel')).toBe(true)
    expect(getOutgoing(db, 'sent-cancel')).toBeNull()

    enqueueOutgoing(db, { id: 'in-flight', accountId: account.id, kind: 'message', threadId: 'in-flight', mail: mail(), messageId: '<x@example.com>' })
    markSending(db, 'in-flight')
    expect(await engine.cancelSend(account.id, 'in-flight')).toBe(false)
    expect(smtp.received.length).toBe(0)
  })

  test('retry and cancel cannot mutate another account or a reply from another thread', async () => {
    const { db, account, engine } = await setup()
    engine.setOffline(true)
    enqueueOutgoing(db, {
      id: 'guarded-reply',
      accountId: account.id,
      kind: 'reply',
      threadId: 'original-thread',
      mail: mail(),
      messageId: '<guarded-reply@example.com>',
    })
    markSending(db, 'guarded-reply')
    markFailed(db, 'guarded-reply', '421 try later', Date.now() + 60_000, 'temporary')

    engine.retry('another-account', 'original-thread', 'guarded-reply')
    expect(getOutgoing(db, 'guarded-reply')?.state).toBe('failed')
    engine.retry(account.id, 'different-thread', 'guarded-reply')
    expect(getOutgoing(db, 'guarded-reply')?.state).toBe('failed')
    expect(await engine.cancelSend('another-account', 'guarded-reply')).toBe(false)
    expect(getOutgoing(db, 'guarded-reply')?.state).toBe('failed')

    expect(requeue(db, account.id, 'guarded-reply', 'original-thread')).toBe(true)
    expect(getOutgoing(db, 'guarded-reply')?.state).toBe('queued')
    expect(await engine.cancelSend(account.id, 'guarded-reply')).toBe(true)
    expect(getOutgoing(db, 'guarded-reply')).toBeNull()
  })

  test('a send interrupted by a crash is recovered at startup and delivered exactly once', async () => {
    const db = openDatabase(':memory:')
    cleanups.push(() => db.close())
    const first = await setup({ db })
    first.engine.dispose()

    // Simulate the process dying mid-send: the row is stuck in 'sending'.
    enqueueOutgoing(db, { id: 'crashed', accountId: first.account.id, kind: 'message', threadId: 'crashed', mail: mail({ subject: 'Survived a crash' }), messageId: '<crash@example.com>' })
    markSending(db, 'crashed')

    const { engine, events } = first.start()
    engine.syncNow(first.account.id, false)
    await waitFor(() => deliveries(events, 'crashed').includes('sent'))
    await Bun.sleep(300)
    expect(first.smtp.received.length).toBe(1)
    expect((await simpleParser(first.smtp.received[0]!)).messageId).toBe('<crash@example.com>')
  })

  test('a reply lost after the whole body went out is unconfirmed, never retried on its own', async () => {
    const { smtp, imap, db, account, engine, events } = await setup({ dataEnd: 'drop', schedulerMs: 20 })
    engine.send(account.id, 'sent-lost', mail({ subject: 'Did this go?' }))
    await waitFor(() => deliveries(events, 'sent-lost').includes('failed'))
    const entry = getOutgoing(db, 'sent-lost')!
    expect(entry).toMatchObject({ state: 'failed', unconfirmed: true, permanent: false, nextAttemptAt: null })
    expect(events.find((event) => event.type === 'outboxState' && event.threadId === 'sent-lost' && event.state === 'failed')).toMatchObject({ unconfirmed: true, nextRetryAt: null })
    expect(smtp.received).toHaveLength(1)

    // Syncs and the retry scheduler leave it alone: the server may have delivered it.
    engine.syncNow(account.id, false)
    await Bun.sleep(400)
    expect(smtp.received).toHaveLength(1)
    expect(dueOutgoing(db, account.id)).toHaveLength(0)
    expect(loadThreads(db, account.id).find((t) => t.id === 'sent-lost')).toMatchObject({ sendState: 'failed', sendUnconfirmed: true })

    // The person says it went: out of the Outbox and filed in Sent, still without sending it again.
    engine.confirmSent(account.id, 'sent-lost')
    await waitFor(() => deliveries(events, 'sent-lost').includes('sent'))
    expect(getOutgoing(db, 'sent-lost')!.state).toBe('sent')
    const filed = await waitFor(async () => (await sentFolder(imap)).find((m) => m.messageId === entry.messageId))
    expect(filed.subject).toBe('Did this go?')
    expect(smtp.received).toHaveLength(1)
  })

  test('Send again on an unconfirmed message sends it once more with the same Message-ID', async () => {
    const { db, account, engine, events } = await setup({ dataEnd: 'drop' })
    engine.send(account.id, 'sent-again', mail())
    await waitFor(() => getOutgoing(db, 'sent-again')?.unconfirmed)
    const entry = getOutgoing(db, 'sent-again')!

    const back = await startFakeSmtp({ cert, users: [USER] })
    cleanups.push(() => back.close())
    engine.setAccounts([{ ...account, servers: { ...account.servers, smtpPort: back.port } }])
    engine.retry(account.id, 'sent-again')
    await waitFor(() => deliveries(events, 'sent-again').includes('sent'))
    expect(back.received).toHaveLength(1)
    expect((await simpleParser(back.received[0]!)).messageId).toBe(entry.messageId)
  })

  test('a server that rejects the message after its body is a known failure, not an unconfirmed one', async () => {
    const { db, account, engine, events } = await setup({ dataEnd: 'reject' })
    engine.send(account.id, 'sent-rejected', mail())
    await waitFor(() => deliveries(events, 'sent-rejected').includes('failed'))
    expect(getOutgoing(db, 'sent-rejected')).toMatchObject({ state: 'failed', unconfirmed: false, permanent: true })
  })

  test('only an unconfirmed message can be marked sent, and only by its own account and thread', async () => {
    const { db, account, engine } = await setup()
    enqueueOutgoing(db, { id: 'plain-failed', accountId: account.id, kind: 'message', threadId: 'plain-failed', mail: mail(), messageId: '<plain@example.com>' })
    markSending(db, 'plain-failed')
    markFailed(db, 'plain-failed', 'Connection refused', null)
    engine.confirmSent(account.id, 'plain-failed')
    enqueueOutgoing(db, { id: 'maybe', accountId: account.id, kind: 'reply', threadId: 'thread-a', mail: mail(), messageId: '<maybe@example.com>' })
    markSending(db, 'maybe')
    markUnconfirmed(db, 'maybe', 'Timeout')
    engine.confirmSent('someone-else', 'thread-a', 'maybe')
    engine.confirmSent(account.id, 'thread-b', 'maybe')
    await Bun.sleep(50)
    expect(getOutgoing(db, 'plain-failed')!.state).toBe('failed')
    expect(getOutgoing(db, 'maybe')!.state).toBe('failed')
    engine.confirmSent(account.id, 'thread-a', 'maybe')
    await waitFor(() => getOutgoing(db, 'maybe')!.state === 'sent')
  })

  test('a send cut off after its body went out is unconfirmed at startup, not sent again', async () => {
    const db = openDatabase(':memory:')
    cleanups.push(() => db.close())
    const first = await setup({ db })
    first.engine.dispose()

    // The process died after handing over the body but before the server's reply arrived.
    enqueueOutgoing(db, { id: 'cut-off', accountId: first.account.id, kind: 'message', threadId: 'cut-off', mail: mail(), messageId: '<cut-off@example.com>' })
    markSending(db, 'cut-off')
    markBodySent(db, 'cut-off')

    const { engine } = first.start()
    engine.syncNow(first.account.id, false)
    await Bun.sleep(500)
    expect(first.smtp.received).toHaveLength(0)
    expect(getOutgoing(db, 'cut-off')).toMatchObject({ state: 'failed', unconfirmed: true, lastError: INTERRUPTED_AFTER_BODY, nextAttemptAt: null })
  })
})

describe('mime helpers', () => {
  test('markdown renders to escaped HTML', () => {
    expect(markdownToHtml('Hi <b>there</b> & **you**')).toBe('<p>Hi &lt;b&gt;there&lt;/b&gt; &amp; <strong>you</strong></p>')
    expect(markdownToHtml('line one\nline two\n\nnext')).toBe('<p>line one<br>line two</p>\n<p>next</p>')
    expect(markdownToHtml('- [x] done\n- [ ] todo')).toBe('<ul><li>☑ done</li><li>☐ todo</li></ul>')
    expect(markdownToHtml('[site](https://jefi.app) and [bad](javascript:alert(1))')).toBe('<p><a href="https://jefi.app">site</a> and [bad](javascript:alert(1))</p>')
  })

  test('markdown lines no block claims still render, and never stall the conversion', () => {
    // An indented heading used to match the paragraph's stop rule but not the heading rule: the loop
    // never advanced and the engine hung (and grew memory) while sending or pushing the draft.
    expect(markdownToHtml('Hello\n  # indented\nbye')).toBe('<p>Hello</p>\n<h1>indented</h1>\n<p>bye</p>')
    expect(markdownToHtml('    # four spaces')).toBe('<p>    # four spaces</p>')
    expect(markdownToHtml('####### seven')).toBe('<p>####### seven</p>')
    const odd = ['  # x', '    ## y', '\t# z', '#', '# ', '1.', '-', '- ', '>', ' >', '***', '* * *', '---', '___', '1.\tx', '  -\tx', '#\tx', '**', '__', '`']
    for (const a of odd) for (const b of odd) expect(typeof markdownToHtml(`${a}\n${b}\ntext`)).toBe('string')
  })

  test('underscores and asterisks in code, links and URLs stay characters', () => {
    expect(markdownToHtml('[doc](https://a.com/_private_/x) and https://b.com/_x_/y')).toBe('<p><a href="https://a.com/_private_/x">doc</a> and https://b.com/_x_/y</p>')
    expect(markdownToHtml('`**not bold**` and `a_b_c` but **bold** and [_em_ label](https://c.com)')).toBe(
      '<p><code>**not bold**</code> and <code>a_b_c</code> but <strong>bold</strong> and <a href="https://c.com"><em>em</em> label</a></p>',
    )
  })

  test('forwarded-message separators become rules', () => {
    expect(markdownToHtml('Hi\n\n---\n\n**Forwarded message**')).toBe('<p>Hi</p>\n<hr>\n<p><strong>Forwarded message</strong></p>')
    expect(markdownToHtml('* * *')).toBe('<hr>')
  })

  test('reply subject and references', () => {
    expect(replySubject('Planning')).toBe('Re: Planning')
    expect(replySubject('RE: Planning')).toBe('RE: Planning')
    expect(replyReferences(['<a>', '<b>'], '<b>')).toEqual(['<a>', '<b>'])
  })

  test('an empty subject is sent empty, not as the words "(no subject)"', () => {
    const account = { id: 'a', name: 'Mara Lin', email: 'me@example.com' } as Parameters<typeof buildOutgoing>[0]
    expect(buildOutgoing(account, mail({ subject: '   ' }), { messageId: '<m@example.com>' }).subject).toBe('')
  })

  test('only attachments with a file on this Mac go out', () => {
    const account = { id: 'a', name: 'Mara Lin', email: 'me@example.com' } as Parameters<typeof buildOutgoing>[0]
    const files = attachmentFiles()
    const built = buildOutgoing(account, mail({ attachments: [...files.attachments, { name: 'from-the-server.pdf', size: '1 KB' }] }), { messageId: '<m@example.com>' })
    expect(built.attachments).toEqual([
      { filename: 'notes.txt', path: files.attachments[0]!.path },
      { filename: 'pixels.bin', path: files.attachments[1]!.path },
    ])
    expect(unreadableAttachment(built)).toBeNull()
    expect(buildOutgoing(account, mail(), { messageId: '<m@example.com>' }).attachments).toBeUndefined()

    rmSync(files.attachments[0]!.path)
    expect(unreadableAttachment(built)).toEqual({ filename: 'notes.txt', problem: 'missing' })
  })

  test('only a failure with no reply after the whole body leaves the outcome unknown', () => {
    const timeout = Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'CONN' })
    expect(sendOutcomeUnknown(timeout, true)).toBe(true)
    expect(sendOutcomeUnknown(timeout, false)).toBe(false)
    expect(sendOutcomeUnknown(Object.assign(new Error('Message failed: 554 spam'), { code: 'EMESSAGE', responseCode: 554 }), true)).toBe(false)
    expect(sendOutcomeUnknown(Object.assign(new Error('Message failed'), { code: 'EMESSAGE', response: '451 try later' }), true)).toBe(false)
  })

  test('SMTP failures split into permanent and temporary', () => {
    expect(classifySmtpError({ code: 'EAUTH', response: '535 no' }).permanent).toBe(true)
    expect(classifySmtpError({ code: 'EAUTH', responseCode: 454, response: '454 temporary authentication failure' }).permanent).toBe(false)
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 550, response: '550 no such user' }).permanent).toBe(true)
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 450, response: '450 mailbox busy' }).permanent).toBe(false)
    expect(classifySmtpError({ code: 'EENVELOPE', message: 'No recipients defined' }).permanent).toBe(true)
    expect(classifySmtpError({ code: 'ECONNECTION', message: 'connect ECONNREFUSED' }).permanent).toBe(false)
    expect(classifySmtpError({ responseCode: 421, response: '421 try later' }).permanent).toBe(false)
    expect(classifySmtpError({ responseCode: 554, response: '554 policy rejection' }).permanent).toBe(true)
    expect(classifySmtpError({ response: '550 sender rejected' }).permanent).toBe(true)
  })

  test('automatic retry has a finite cap and a manual retry starts a fresh budget', () => {
    expect(nextAutomaticRetryAt(1, 1_000)).toBe(61_000)
    expect(nextAutomaticRetryAt(3, 1_000)).toBe(901_000)
    expect(nextAutomaticRetryAt(MAX_AUTOMATIC_ATTEMPTS, 1_000)).toBeNull()

    const db = openDatabase(':memory:')
    db.run("INSERT INTO accounts (id, email, created_at) VALUES ('retry-account', 'me@example.com', 1)")
    enqueueOutgoing(db, {
      id: 'retry-budget',
      accountId: 'retry-account',
      kind: 'message',
      threadId: 'retry-budget',
      mail: mail(),
      messageId: '<stable@example.com>',
    })
    for (let attempt = 0; attempt < MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      markSending(db, 'retry-budget')
      if (attempt + 1 < MAX_AUTOMATIC_ATTEMPTS) markFailed(db, 'retry-budget', 'still unavailable', Date.now(), 'temporary')
    }
    markFailed(db, 'retry-budget', 'still unavailable', null, 'exhausted')
    expect(getOutgoing(db, 'retry-budget')).toMatchObject({ attempts: MAX_AUTOMATIC_ATTEMPTS, retryStopped: true, permanent: false })
    expect(dueOutgoing(db, 'retry-account', Number.MAX_SAFE_INTEGER)).toEqual([])
    expect(requeue(db, 'retry-account', 'retry-budget', 'retry-budget')).toBe(true)
    expect(getOutgoing(db, 'retry-budget')).toMatchObject({ attempts: 0, retryStopped: false, messageId: '<stable@example.com>' })
    db.close()
  })
})
