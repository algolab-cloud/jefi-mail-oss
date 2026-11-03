import { open, readFile } from 'node:fs/promises'
import type { MailThread, Message } from './data'
import { messageText } from './reply'

const MAX_HEADER_BYTES = 1024 * 1024

/** Return the exact header block (including folding) without parsing or normalizing it. */
export function rawHeaderBlock(source: Uint8Array): string {
  const bytes = Buffer.from(source)
  const crlf = bytes.indexOf('\r\n\r\n')
  const lf = bytes.indexOf('\n\n')
  const end = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf
  if (end < 0) throw new Error('This message has no complete header block')
  if (end > MAX_HEADER_BYTES) throw new Error('Message headers are too large to display')
  return bytes.subarray(0, end).toString('utf8')
}

/** Read only enough of an .eml file to display its raw headers. */
export async function readRawHeaders(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES + 4)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return rawHeaderBlock(buffer.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

export const MAX_READER_MATCHES = 10_000

export const countTextMatches = (text: string, query: string, maximum = Number.POSITIVE_INFINITY) => {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return 0
  const haystack = text.toLocaleLowerCase()
  let count = 0
  for (let at = 0; count < maximum && (at = haystack.indexOf(needle, at)) >= 0; at += Math.max(needle.length, 1)) count++
  return count
}

/** `lower` is `text.toLocaleLowerCase()`, precomputed by callers that search the same rows repeatedly. */
export type ReaderSearchRow = { key: string; text: string; lower?: string }
export type ReaderMatch = { key: string; rowIndex: number; occurrence: number; start: number; end: number }

/** Plain text close to what GPUIX Markdown paints, used only for body-local find indexing. */
export function markdownSearchText(source: string) {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, '$1')
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!<>|])/g, '$1')
    .replace(/(\*\*|__|~~|`|\*|_)/g, '')
    .replace(/ {2}\n/g, '\n')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}

/** Find body occurrences by rendered row, so each row can own its native active highlight index. */
export function findReaderMatches(rows: readonly ReaderSearchRow[], query: string): { matches: ReaderMatch[]; truncated: boolean } {
  const matches: ReaderMatch[] = []
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return { matches, truncated: false }
  for (const [rowIndex, row] of rows.entries()) {
    const text = row.lower ?? row.text.toLocaleLowerCase()
    let occurrence = 0
    for (let start = 0; (start = text.indexOf(needle, start)) >= 0; start += Math.max(needle.length, 1)) {
      if (matches.length >= MAX_READER_MATCHES) return { matches, truncated: true }
      matches.push({ key: row.key, rowIndex, occurrence: occurrence++, start, end: start + needle.length })
    }
  }
  return { matches, truncated: false }
}

const printableMessage = (message: Message) => [
  `From: ${message.from} <${message.email}>`,
  `To: ${message.to}`,
  `Date: ${message.timestamp ? new Date(message.timestamp).toLocaleString() : message.time}`,
  ...(message.messageId ? [`Message-ID: ${message.messageId}`] : []),
  '',
  messageText(message),
  ...(message.attachments?.length ? ['', `Attachments: ${message.attachments.map((item) => `${item.name} (${item.size})`).join(', ')}`] : []),
].join('\n')

/** A deterministic print document that never embeds or requests remote resources. */
export function printableThread(thread: MailThread, only?: Message) {
  const messages = only ? [only] : thread.messages
  return [`Subject: ${thread.subject}`, '', ...messages.flatMap((message, index) => [printableMessage(message), ...(index < messages.length - 1 ? ['', '────────────────────────────────────────', ''] : [])])].join('\n')
}

/** Used by tests and callers that need the full original after its bounded cache fetch. */
export const readOriginalBytes = (path: string) => readFile(path)
