import { useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Something handed to the assistant from elsewhere in the app (an AI summary, for now). It waits
// above the chat box and goes along with the person's next message, so they can ask about it.
// ---------------------------------------------------------------------------

export type Handoff = { title: string; text: string }

let pending: Handoff | null = null
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Hands `item` to the assistant, replacing anything handed over earlier and not yet sent. */
export function sendToAssistant(item: Handoff) {
  pending = item
  changed()
}

export function clearHandoff() {
  if (!pending) return
  pending = null
  changed()
}

export const currentHandoff = () => pending
export const useHandoff = () => useSyncExternalStore(subscribe, currentHandoff, currentHandoff)
/** Calls `listener` with each new handoff (the app opens the assistant for it). */
export const onHandoff = (listener: (item: Handoff) => void) => subscribe(() => pending && listener(pending))

/**
 * The person's message as the model gets it: the handed-over text first, marked as what it is.
 * A summary is the model's reading of mail other people wrote, so it's information, not instructions.
 */
export function withHandoff(message: string, item: Handoff | null) {
  if (!item) return message
  const title = item.title.replace(/["<>]/g, "'")
  const text = item.text.replace(/<\/attached>/gi, '</ attached>')
  return `<attached title="${title}">\n${text}\n</attached>\n\n${message}`
}
