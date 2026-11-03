// Groups new-mail announcements so a burst of arrivals shows one toast (and one banner) per account.

export const BURST_WINDOW_MS = 4000

export type IncomingThread = { id: string; sender: string; subject: string; screened?: boolean }

/**
 * An arrival as it should be announced: from whoever sent the newest message. A conversation's list
 * sender names everyone in it with a count ("Nora Hale, Kenji Ito (3)"), which is not who just wrote.
 */
export function incomingThread(thread: { id: string; sender: string; subject: string; screened?: boolean; messages?: ReadonlyArray<{ from: string }> }): IncomingThread {
  const newest = thread.messages?.at(-1)?.from?.trim()
  const sender = newest || thread.sender.replace(/\s+\(\d+\)$/, '')
  return { id: thread.id, sender, subject: thread.subject, ...(thread.screened ? { screened: true } : {}) }
}

/** Newest first; `at` is when the burst last grew. */
export type NewMailBurst = { threads: IncomingThread[]; at: number }

export type NewMailCopy = { title: string; description: string; threadId: string }

/** Folds an event's new conversations into the running burst. A burst older than the window starts
 *  over; screened mail and threads already counted are ignored. Returns null when nothing was added. */
export function addToBurst(prev: NewMailBurst | undefined, incoming: IncomingThread[], now: number, windowMs = BURST_WINDOW_MS): NewMailBurst | null {
  const base = prev && now - prev.at <= windowMs ? prev.threads : []
  const seen = new Set(base.map((t) => t.id))
  const added: IncomingThread[] = []
  for (const thread of incoming) {
    if (thread.screened || seen.has(thread.id)) continue
    seen.add(thread.id)
    added.push(thread)
  }
  if (added.length === 0) return null
  return { threads: [...added.reverse(), ...base], at: now }
}

/** "Ada", "Ada and Bob", "Ada, Bob and 1 other", "Ada, Bob and 3 others" (distinct senders). */
export function senderSummary(senders: string[]): string {
  const names = [...new Set(senders)]
  if (names.length <= 2) return names.join(' and ')
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? 'other' : 'others'}`
}

export function newMailCopy(burst: NewMailBurst): NewMailCopy {
  const newest = burst.threads[0]!
  if (burst.threads.length === 1) return { title: `New message from ${newest.sender}`, description: newest.subject, threadId: newest.id }
  // Senders in arrival order read more naturally than newest first.
  const senders = [...burst.threads].reverse().map((t) => t.sender)
  return { title: `${burst.threads.length} new messages`, description: senderSummary(senders), threadId: newest.id }
}
