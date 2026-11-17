import { useSyncExternalStore } from 'react'
import type { Contact, MailThread } from './data'

// ---------------------------------------------------------------------------
// What's handed to the assistant from elsewhere in the app (an AI summary, conversations, people
// @-mentioned in the chat box). It waits above the chat box and goes along with the person's next
// message, so they can ask about it.
// ---------------------------------------------------------------------------

export type Handoff = { title: string; text: string; threadId?: string; contact?: string }

const NONE: readonly Handoff[] = []
let pending: readonly Handoff[] = NONE
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

const sameItem = (a: Handoff, b: Handoff) =>
  a.threadId || b.threadId ? a.threadId === b.threadId : a.contact || b.contact ? a.contact === b.contact : a.title === b.title && a.text === b.text

const threadItem = (thread: Pick<MailThread, 'id' | 'subject'>): Handoff => ({ title: thread.subject.trim() || '(no subject)', text: `Email thread_id: ${thread.id}`, threadId: thread.id })

/** Hands `items` to the assistant, replacing anything handed over earlier and not yet sent. */
export function sendToAssistant(...items: Handoff[]) {
  pending = items.length ? items : NONE
  changed()
}

/** Adds one more item to what's waiting (an @-mention), keeping the rest. */
export function attachToAssistant(item: Handoff) {
  if (pending.some((p) => sameItem(p, item))) return
  pending = [...pending, item]
  changed()
}

export function removeHandoff(item: Handoff) {
  const next = pending.filter((p) => !sameItem(p, item))
  if (next.length === pending.length) return
  pending = next.length ? next : NONE
  changed()
}

/** Attach exact identities; the assistant loads each full conversation when the person sends. */
export function chatAboutThreads(threads: Pick<MailThread, 'id' | 'subject'>[]) {
  sendToAssistant(...threads.map(threadItem))
}

export const chatAboutThread = (thread: Pick<MailThread, 'id' | 'subject'>) => chatAboutThreads([thread])

/** One conversation, added to what's waiting. */
export const attachThread = (thread: Pick<MailThread, 'id' | 'subject'>) => attachToAssistant(threadItem(thread))

/** A person, added to what's waiting: the model can search for mail with them. */
export const attachContact = (contact: Pick<Contact, 'name' | 'email'>) =>
  attachToAssistant({ title: contact.name || contact.email, text: `Person: ${contact.name ? `${contact.name} <${contact.email}>` : contact.email}`, contact: contact.email.toLowerCase() })

export function clearHandoff() {
  if (!pending.length) return
  pending = NONE
  changed()
}

export const currentHandoffs = () => pending
/** The first item waiting, or null. */
export const currentHandoff = () => pending[0] ?? null
export const useHandoffs = () => useSyncExternalStore(subscribe, currentHandoffs, currentHandoffs)
/** Calls `listener` with the first item of each new handoff (the app opens the assistant for it). */
export const onHandoff = (listener: (item: Handoff) => void) => subscribe(() => pending[0] && listener(pending[0]))

/** A short label for a list of attachments: the one title, or "Budget review + 2 more". */
export const handoffLabel = (items: readonly Handoff[]) => (items.length <= 1 ? (items[0]?.title ?? '') : `${items[0]!.title} + ${items.length - 1} more`)

/**
 * The person's message as the model gets it: the handed-over text first, marked as what it is.
 * A summary is the model's reading of mail other people wrote, so it's information, not instructions.
 */
export function withHandoff(message: string, items: readonly Handoff[] | Handoff | null) {
  const list = !items ? [] : Array.isArray(items) ? (items as readonly Handoff[]) : [items as Handoff]
  if (!list.length) return message
  const blocks = list.map((item) => {
    const title = item.title.replace(/["<>]/g, "'")
    const text = item.text.replace(/<\/attached>/gi, '</ attached>')
    return `<attached title="${title}">\n${text}\n</attached>`
  })
  return `${blocks.join('\n')}\n\n${message}`
}
