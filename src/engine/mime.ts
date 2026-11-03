import type { Account } from '../accounts'
import type { DraftFields } from '../data'

// ---------------------------------------------------------------------------
// Outgoing mail: Jefi's composer writes markdown, recipients get multipart/alternative with the
// markdown as the text part and a small, escaped HTML rendering of it. Replies carry In-Reply-To
// and References so every client threads them.
// ---------------------------------------------------------------------------

export type ReplyHeaders = { inReplyTo: string; references: string[] }

export type OutgoingMessage = {
  messageId: string
  from: { name: string; address: string }
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string
  date: Date
  inReplyTo?: string
  references?: string[]
  /** Files read from disk at send time; nodemailer/MailComposer streams them into the message. */
  attachments?: OutgoingAttachment[]
  /** An iTIP message (calendar/invites.ts): the text/calendar alternative, and invite.ics when `attach`. */
  calendar?: OutgoingCalendar
}

/**
 * The iCalendar an invitation, cancellation or reply carries. REQUEST and CANCEL go out with an HTML
 * part and an invite.ics copy too (`attach`); a REPLY is just text plus text/calendar, as RFC 6047
 * describes and Gmail and Outlook send.
 */
export type OutgoingCalendar = { method: 'REQUEST' | 'CANCEL' | 'REPLY'; ics: string; attach: boolean }

export type OutgoingAttachment = { filename: string; path: string; contentType?: string }

export function newMessageId(account: Pick<Account, 'email'>) {
  const domain = account.email.split('@')[1] || 'jefi.local'
  return `<${crypto.randomUUID()}@${domain}>`
}

export function buildOutgoing(account: Account, mail: DraftFields, options: { messageId: string; reply?: ReplyHeaders; date?: Date; calendar?: OutgoingCalendar }): OutgoingMessage {
  const text = mail.body.replace(/\r\n/g, '\n')
  // Received mail carries attachments without a path (they live on the server); only files picked
  // on this Mac can go out.
  const attachments = (mail.attachments ?? []).flatMap((file) => (file.path ? [{ filename: file.name, path: file.path }] : []))
  return {
    messageId: options.messageId,
    from: { name: account.name, address: account.email },
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    // An empty subject goes out empty: "(no subject)" is how the list shows one, not the recipient's subject line.
    subject: mail.subject.trim(),
    text,
    html: options.calendar && !options.calendar.attach ? '' : markdownToHtml(text),
    date: options.date ?? new Date(),
    ...(attachments.length ? { attachments } : {}),
    ...(options.calendar ? { calendar: options.calendar } : {}),
    ...(options.reply ? { inReplyTo: options.reply.inReplyTo, references: options.reply.references } : {}),
  }
}

export const replySubject = (subject: string) => (/^\s*re:/i.test(subject) ? subject : `Re: ${subject}`)

/** References for a reply: the parent's references plus the parent itself, without duplicates. */
export const replyReferences = (parentReferences: string[], parentMessageId: string) => [...new Set([...parentReferences, parentMessageId])]

// --- Markdown → HTML ---------------------------------------------------------------------------

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const emphasis = (html: string) =>
  html
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')

/**
 * Code spans, link targets and bare URLs are set aside before emphasis runs, so an underscore or
 * asterisk inside them stays a character: `a_b_c`, https://x.com/_private_/ and a link to it would
 * otherwise get <em> tags inside the code, the text and the href.
 */
const inline = (value: string) => {
  const kept: string[] = []
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`
  const text = escapeHtml(value.replace(/\u0000/g, ''))
    .replace(/`([^`]+)`/g, (_, code: string) => keep(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, label: string, href: string) => `${keep(`<a href="${href}">`)}${label}${keep('</a>')}`)
    .replace(/(?:https?:\/\/|mailto:)[^\s<]+/g, (url) => keep(url))
  return emphasis(text).replace(/\u0000(\d+)\u0000/g, (_, index: string) => kept[Number(index)]!)
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const BLOCK_START = /^\s*(>|[-*+]\s|\d+\.\s)/

export function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${markdownToHtml(quoted.join('\n'))}</blockquote>`)
      continue
    }
    const bullet = /^\s*[-*+]\s+(\[[ xX]\]\s+)?(.*)$/
    if (bullet.test(line)) {
      const items: string[] = []
      while (i < lines.length && bullet.test(lines[i]!)) {
        const [, task, content] = lines[i++]!.match(bullet)!
        const box = task ? (/\[[xX]\]/.test(task) ? '☑ ' : '☐ ') : ''
        items.push(`<li>${box}${inline(content!)}</li>`)
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    const numbered = /^\s*\d+\.\s+(.*)$/
    if (numbered.test(line)) {
      const items: string[] = []
      while (i < lines.length && numbered.test(lines[i]!)) items.push(`<li>${inline(lines[i++]!.match(numbered)![1]!)}</li>`)
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      const level = heading[1]!.length
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      i++
      continue
    }
    // Paragraph: consecutive plain lines, single newlines kept as line breaks (mail is written that way).
    // The first line is always taken, so a line no block above claims can never stall the loop.
    const paragraph = [inline(lines[i++]!)]
    while (i < lines.length && lines[i]!.trim() && !BLOCK_START.test(lines[i]!) && !HEADING.test(lines[i]!) && !RULE.test(lines[i]!)) paragraph.push(inline(lines[i++]!))
    out.push(`<p>${paragraph.join('<br>')}</p>`)
  }
  return out.join('\n')
}
