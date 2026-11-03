import type { DraftFields, MailAddress, MailThread, Message } from './data'
import { replySubject } from './engine/mime'

export type ReplyMode = 'reply' | 'replyAll'

/** A message body as markdown, for quoting in replies and forwards. */
export function messageText(message: Message) {
  if (message.markdown !== undefined) return message.markdown
  return message.paragraphs.map((block) => (Array.isArray(block) ? block.map((line) => `- ${line}`).join('\n') : block)).join('\n\n')
}

const emailKey = (email: string) => email.trim().toLowerCase()

const uniqueEmails = (addresses: readonly MailAddress[], excluded: Set<string>): string[] => {
  const result: string[] = []
  const seen = new Set(excluded)
  for (const address of addresses) {
    const email = address.email.trim()
    const key = emailKey(email)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(email)
  }
  return result
}

const fromAddresses = (message: Message): MailAddress[] => {
  if (message.replyToAddresses?.length) return message.replyToAddresses
  if (message.fromAddress?.email) return [message.fromAddress]
  return message.email.trim() ? [{ email: message.email }] : []
}

/**
 * Recipients come only from the selected message's structured headers. Presentation names and
 * other messages in the conversation are deliberately ignored: neither is authoritative routing.
 */
export function replyRecipients(message: Message, mode: ReplyMode, ownIdentities: readonly string[]) {
  const own = new Set(ownIdentities.map(emailKey).filter(Boolean))
  const direct = message.toAddresses ?? []
  let to = uniqueEmails(fromAddresses(message), own)
  // Replying to one's own sent message targets its direct recipients instead of oneself.
  if (!to.length) to = uniqueEmails(direct, own)
  if (mode === 'reply') return { to, cc: [] as string[] }

  const alreadyTo = new Set([...own, ...to.map(emailKey)])
  const cc = uniqueEmails([...direct, ...(message.ccAddresses ?? [])], alreadyTo)
  return { to, cc }
}

const quotedAt = (message: Message) => message.timestamp === undefined ? message.time : new Date(message.timestamp).toLocaleString()

/** A Reply or Reply all draft for one selected message, including only that message's recipients. */
export function replyDraft(
  thread: MailThread,
  message: Message,
  mode: ReplyMode,
  ownIdentities: readonly string[],
  written = '',
): DraftFields {
  return {
    ...replyRecipients(message, mode, ownIdentities),
    bcc: [],
    subject: replySubject(thread.subject),
    body: `${written}\n\n> On ${quotedAt(message)}, ${message.from} wrote:\n>\n${messageText(message)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`,
  }
}
