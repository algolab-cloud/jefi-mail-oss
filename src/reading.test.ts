import { describe, expect, test } from 'bun:test'
import type { MailThread, Message } from './data'
import { forwardDraft, forwardSubject, messageParts, outboxFailureText, prepareForwardDraft, readerChips, splitQuotedParagraphs } from './reading'

const message = {
  id: 'account:t1-7',
  from: 'Ada',
  email: 'ada@example.com',
  to: 'Me',
  face: {},
  time: '10:30 AM',
  paragraphs: ['Please review.'],
  attachments: [
    { name: 'one.txt', size: '3 B' },
    { name: 'two.txt', size: '3 B' },
  ],
} satisfies Message

const thread = { subject: 'Review', messages: [message] } as MailThread

describe('forward preparation', () => {
  test('materializes every attachment before opening a forward draft', async () => {
    const requested: number[] = []
    const result = await prepareForwardDraft(thread, message, async (_messageId, index, attachment) => {
      requested.push(index)
      return { ok: true, attachment: { ...attachment, path: `/cache/${attachment.name}` } }
    })

    expect(requested).toEqual([0, 1])
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      draft: expect.objectContaining({
        subject: 'Fwd: Review',
        attachments: [
          { name: 'one.txt', size: '3 B', path: '/cache/one.txt' },
          { name: 'two.txt', size: '3 B', path: '/cache/two.txt' },
        ],
      }),
    }))
  })

  test('aborts the whole forward on the first missing file', async () => {
    const requested: number[] = []
    const result = await prepareForwardDraft(thread, message, async (_messageId, index, attachment) => {
      requested.push(index)
      return index === 0
        ? { ok: false, error: "You're offline" }
        : { ok: true, attachment: { ...attachment, path: `/cache/${attachment.name}` } }
    })

    expect(requested).toEqual([0])
    expect(result).toEqual({ ok: false, error: "one.txt: You're offline" })
  })
})

describe('outbox failure detail', () => {
  test('distinguishes permanent rejection and stopped automatic retries', () => {
    expect(outboxFailureText({ sendPermanent: true } as MailThread, 'fallback')).toBe('Sending stopped · retry manually')
    expect(outboxFailureText({ sendPermanent: true, sendError: 'Attachment is missing' } as MailThread, 'fallback')).toBe('Sending stopped · Attachment is missing · retry manually')
    expect(outboxFailureText({ sendRetryStopped: true, sendAttempts: 5 } as MailThread, 'fallback')).toBe('Automatic retries stopped after 5 attempts')
    expect(outboxFailureText({ sendRetryStopped: true, sendAttempts: 8, sendError: '421 Busy' } as MailThread, 'fallback')).toBe('Automatic retries stopped after 8 attempts · 421 Busy')
  })

  test('shows attempt count for a scheduled retry and otherwise preserves the server error', () => {
    expect(outboxFailureText({ sendRetryAt: Date.now() + 30_000, sendAttempts: 2 } as MailThread, 'fallback')).toMatch(/^Attempt 2 · retrying /)
    expect(outboxFailureText({ sendRetryAt: Date.now() + 30_000, sendAttempts: 1, sendError: 'connect ECONNREFUSED' } as MailThread, 'fallback')).toMatch(/^Attempt 1 · retrying .* · connect ECONNREFUSED$/)
    expect(outboxFailureText({ sendError: 'Temporary SMTP failure' } as MailThread, 'fallback')).toBe('Temporary SMTP failure')
  })
})

describe('reader chips', () => {
  const base = { folder: 'inbox', labels: [], messages: [] } as unknown as MailThread
  const folders = [{ path: 'Projects', name: 'Projects', depth: 0 }]
  const label = { id: 'l1', label: 'Work', color: 'green' as const }

  test('a conversation in the Inbox and a custom folder, without labels, has no label dot to look up', () => {
    const chips = readerChips({ ...base, folders: ['Projects'] }, folders, [])
    expect(chips).toEqual([{ key: 'mailbox', name: 'Inbox' }, { key: 'folder:Projects', name: 'Projects' }])
  })

  test('only labels carry a tone, whatever comes before them', () => {
    const chips = readerChips({ ...base, folders: ['Projects', 'Gone'] }, folders, [label])
    expect(chips.map((c) => [c.name, c.tone])).toEqual([['Inbox', undefined], ['Projects', undefined], ['Gone', undefined], ['Work', 'green']])
  })

  test('mail only in custom folders skips the placeholder mailbox; screened mail says Screener', () => {
    expect(readerChips({ ...base, folders: ['Projects'], onlyInFolders: true }, folders, [label]).map((c) => c.name)).toEqual(['Projects', 'Work'])
    expect(readerChips({ ...base, screened: true }, folders, []).map((c) => c.name)).toEqual(['Screener'])
  })
})

describe('one message open at a time', () => {
  test('the open message is read in the HTML view; the others are a row each', () => {
    const plain = { ...message, attachments: undefined, html: undefined, markdown: undefined, paragraphs: ['Hello'] } as Message
    expect(messageParts(plain, 'html').map((part) => part.kind)).toEqual(['head', 'full', 'foot'])
    expect(messageParts(plain, 'collapsed').map((part) => part.kind)).toEqual(['collapsed'])
    expect(messageParts({ ...plain, bodyMissing: true }, 'html').map((part) => part.kind)).toEqual(['head', 'loading', 'foot'])
  })
})

describe('plain-text quoted history', () => {
  const plain = (paragraphs: Message['paragraphs']) => ({ ...message, attachments: undefined, paragraphs }) as Message

  test('a plain-text reply folds the attribution and quote behind the toggle', () => {
    const reply = plain(['Sounds good to me.', 'On Tue, Lea Ortiz wrote:\n> Are we still on for Friday?\n> Let me know.'])
    expect(splitQuotedParagraphs(reply.paragraphs)).toEqual({ body: ['Sounds good to me.'], quoted: ['On Tue, Lea Ortiz wrote:\n> Are we still on for Friday?\n> Let me know.'] })
    const kinds = messageParts(reply, 'text').map((part) => part.kind)
    expect(kinds).toEqual(['head', 'paragraphs', 'quoted', 'foot'])
    const open = messageParts(reply, 'text', true)
    expect(open.map((part) => part.kind)).toEqual(['head', 'paragraphs', 'quoted', 'paragraphs', 'foot'])
    expect(open[3]).toEqual({ kind: 'paragraphs', blocks: ['On Tue, Lea Ortiz wrote:\n> Are we still on for Friday?\n> Let me know.'], first: false })
  })

  test('mail without a trailing quote, or that is only a quote, draws as before', () => {
    expect(splitQuotedParagraphs(['Hello', '> quoted in the middle', 'and an answer'])).toBeNull()
    expect(splitQuotedParagraphs(['> just a forward'])).toBeNull()
    expect(splitQuotedParagraphs([['a list item'], '> quote'])).toBeNull()
    expect(messageParts(plain(['Hello', 'Thanks']), 'text').map((part) => part.kind)).toEqual(['head', 'paragraphs', 'foot'])
  })
})

describe('forward draft', () => {
  test('carries the original headers, with the full date', () => {
    const original = {
      ...message,
      timestamp: Date.UTC(2026, 2, 3, 14, 5),
      fromAddress: { name: 'Ada Lovelace', email: 'ada@example.com' },
      toAddresses: [{ name: 'Me', email: 'me@example.com' }],
      ccAddresses: [{ email: 'team@example.com' }],
    }
    const body = forwardDraft(thread, original, []).body
    expect(body).toContain('From: Ada Lovelace <ada@example.com>')
    expect(body).toContain('Subject: Review')
    expect(body).toContain('To: Me <me@example.com>')
    expect(body).toContain('Cc: team@example.com')
    expect(body).toMatch(/Date: .*2026/)
    expect(body).toContain('Please review.')
  })

  test('adds Fwd: once, whatever case or spelling is already there', () => {
    expect(forwardSubject('Review')).toBe('Fwd: Review')
    expect(forwardSubject('Fwd: Review')).toBe('Fwd: Review')
    expect(forwardSubject('FW: Review')).toBe('FW: Review')
    expect(forwardSubject('fwd: Review')).toBe('fwd: Review')
  })
})
