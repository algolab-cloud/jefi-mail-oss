import { describe, expect, test } from 'bun:test'
import type { MailThread, Message } from './data'
import { replyDraft, replyRecipients } from './reply'

const message = (change: Partial<Message> = {}): Message => ({
  id: 'message-1',
  from: 'Ada',
  email: 'ada@example.com',
  fromAddress: { name: 'Ada', email: 'ada@example.com' },
  to: 'Me',
  toAddresses: [{ name: 'Me', email: 'me@example.com' }],
  ccAddresses: [],
  replyToAddresses: [],
  face: { letter: 'A' },
  time: '10:30 AM',
  timestamp: Date.parse('2026-09-20T07:30:00Z'),
  paragraphs: ['Hello'],
  ...change,
})

const thread = (messages: Message[]): MailThread => ({ id: 'thread-1', subject: 'Planning', messages } as MailThread)

describe('reply recipients', () => {
  test('uses the selected older message and never collects removed historical participants', () => {
    const selected = message({
      id: 'older',
      replyToAddresses: [{ name: 'Project desk', email: 'help@example.com' }],
      toAddresses: [
        { email: 'me@example.com' },
        { email: 'project@example.com' },
      ],
      ccAddresses: [
        { email: 'bob@example.com' },
        { email: 'other-me@example.com' },
      ],
    })
    const latest = message({ id: 'latest', fromAddress: { email: 'new-person@example.com' }, email: 'new-person@example.com' })

    expect(replyRecipients(selected, 'replyAll', ['ME@example.com', 'other-me@example.com'])).toEqual({
      to: ['help@example.com'],
      cc: ['project@example.com', 'bob@example.com'],
    })
    expect(replyDraft(thread([selected, latest]), selected, 'reply', ['me@example.com'])).toMatchObject({
      to: ['help@example.com'],
      cc: [],
      bcc: [],
    })
  })

  test('deduplicates case-insensitively without merging different addresses that share a name', () => {
    const selected = message({
      replyToAddresses: [
        { name: 'Alex', email: 'Shared@Example.com' },
        { name: 'Alex', email: 'shared@example.com' },
      ],
      toAddresses: [{ name: 'Alex', email: 'alex.one@example.com' }],
      ccAddresses: [
        { name: 'Alex', email: 'ALEX.ONE@example.com' },
        { name: 'Alex', email: 'alex.two@example.com' },
      ],
    })

    expect(replyRecipients(selected, 'replyAll', [])).toEqual({
      to: ['Shared@Example.com'],
      cc: ['alex.one@example.com', 'alex.two@example.com'],
    })
  })

  test('excludes every own identity and replies to direct recipients of an own sent message', () => {
    const selected = message({
      email: 'work@example.com',
      fromAddress: { email: 'work@example.com' },
      toAddresses: [
        { email: 'personal@example.com' },
        { email: 'client@example.com' },
      ],
      ccAddresses: [{ email: 'WORK@example.com' }, { email: 'assistant@example.com' }],
    })

    expect(replyRecipients(selected, 'reply', ['work@example.com', 'personal@example.com'])).toEqual({ to: ['client@example.com'], cc: [] })
    expect(replyRecipients(selected, 'replyAll', ['work@example.com', 'personal@example.com'])).toEqual({
      to: ['client@example.com'],
      cc: ['assistant@example.com'],
    })
  })

  test('uses structured From and never guesses an address from presentation names', () => {
    const selected = message({
      email: 'stale@example.com',
      fromAddress: { name: 'Pat', email: 'pat@example.com' },
      to: 'Sam, Taylor · cc Morgan',
      toAddresses: undefined,
      ccAddresses: undefined,
    })

    expect(replyRecipients(selected, 'replyAll', [])).toEqual({ to: ['pat@example.com'], cc: [] })
  })

  test('returns no recipient when routing headers are absent instead of guessing from names', () => {
    const selected = message({
      from: 'Pat',
      email: '',
      fromAddress: undefined,
      replyToAddresses: undefined,
      to: 'Sam, Taylor · cc Morgan',
      toAddresses: undefined,
      ccAddresses: undefined,
    })

    expect(replyRecipients(selected, 'replyAll', ['me@example.com'])).toEqual({ to: [], cc: [] })
  })

  test('quotes the selected message timestamp and never adds Bcc', () => {
    const selected = message()
    const draft = replyDraft(thread([selected]), selected, 'reply', ['me@example.com'], 'Sounds good.')
    expect(draft.bcc).toEqual([])
    expect(draft.body).toContain(`> On ${new Date(selected.timestamp!).toLocaleString()}, Ada wrote:`)
    expect(draft.body).toContain('> Hello')
  })
})
