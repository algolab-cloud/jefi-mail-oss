import { describe, expect, test } from 'bun:test'
import type { MailThread, Message } from './data'
import { countTextMatches, findReaderMatches, markdownSearchText, printableThread, rawHeaderBlock } from './reader-tools'

const message = (id: string, body: string): Message => ({
  id,
  from: 'Sender',
  email: 'sender@example.com',
  to: 'Me',
  face: { letter: 'S' },
  time: 'Now',
  paragraphs: [body],
})

const thread = (messages: Message[]): MailThread => ({
  id: 'acct:t1', sender: 'Sender', subject: 'Subject', snippet: '', date: 'Now', group: 'Today', unread: false, starred: false,
  icons: [], priority: false, tag: 'Inbox', face: { letter: 'S' }, messages, folder: 'inbox', labels: [],
})

describe('raw message headers', () => {
  test('preserves original folding and line endings', () => {
    const source = Buffer.from('From: A <a@example.com>\r\nX-Long: one\r\n\ttwo\r\n\r\nBody\r\n')
    expect(rawHeaderBlock(source)).toBe('From: A <a@example.com>\r\nX-Long: one\r\n\ttwo')
  })

  test('requires a complete bounded header block', () => {
    expect(() => rawHeaderBlock(Buffer.from('From: a@example.com'))).toThrow('complete header')
  })
})

describe('reader find and print', () => {
  test('counts non-overlapping matches across hydrated messages', () => {
    expect(countTextMatches('aaaa', 'aa')).toBe(2)
    expect(findReaderMatches([{ key: 'm1', text: 'Alpha alpha' }, { key: 'm2', text: 'No match' }, { key: 'm3', text: 'ALPHA' }], 'alpha')).toEqual({
      truncated: false,
      matches: [
        { key: 'm1', rowIndex: 0, occurrence: 0, start: 0, end: 5 },
        { key: 'm1', rowIndex: 0, occurrence: 1, start: 6, end: 11 },
        { key: 'm3', rowIndex: 2, occurrence: 0, start: 0, end: 5 },
      ],
    })
  })

  test('bounds result allocation for pathological repeated matches', () => {
    const result = findReaderMatches([{ key: 'm1', text: 'a'.repeat(20_000) }], 'a')
    expect(result.matches).toHaveLength(10_000)
    expect(result.truncated).toBe(true)
  })

  test('searches visible markdown labels instead of hidden destinations and syntax', () => {
    expect(markdownSearchText('## **Read** [the report](https://hidden.example/token)')).toBe('Read the report')
    expect(findReaderMatches([{ key: 'body', text: markdownSearchText('[Visible](https://secret.example)') }], 'secret')).toEqual({ matches: [], truncated: false })
  })

  test('print output is deterministic plain text with attachment names', () => {
    const mail = message('m1', 'Read this')
    mail.attachments = [{ name: 'report.pdf', size: '2 MB' }]
    const output = printableThread(thread([mail]))
    expect(output).toContain('Subject: Subject')
    expect(output).toContain('Read this')
    expect(output).toContain('Attachments: report.pdf (2 MB)')
    expect(output).not.toContain('<html')
  })
})

test('find text decodes entities once, as the reader shows them', () => {
  expect(markdownSearchText('Write &amp;lt;b&amp;gt; for &lt;b&gt; &amp; &quot;bold&quot;')).toBe('Write &lt;b&gt; for <b> & "bold"')
})

test('precomputed lowercase text finds exactly what lowercasing per search finds', () => {
  const rows = [{ key: 'a', text: 'Quarterly QUARTER report' }, { key: 'b', text: 'no match here' }, { key: 'c', text: 'quarter' }]
  const cached = rows.map((row) => ({ ...row, lower: row.text.toLocaleLowerCase() }))
  for (const query of ['q', 'QUART', ' quarter ', 'report', 'zzz']) expect(findReaderMatches(cached, query)).toEqual(findReaderMatches(rows, query))
})
