import type { MailThread } from './data'

// ---------------------------------------------------------------------------
// The Inbox badge (sidebar, account switcher, Dock). The list holds only the account's newest
// conversations, so counting it undercounts any Inbox bigger than that window. The engine counts the
// whole Inbox with each complete publish; between publishes, reading or archiving what's on screen
// moves the badge at once by the change within that publish's window.
// ---------------------------------------------------------------------------

/** The engine's whole-Inbox count, and how much of it the window it published held. */
export type UnreadBasis = { total: number; window: ReadonlySet<string>; inWindow: number }

/** What the badge counts: unread Inbox conversations, not ones waiting in the Screener. */
export const countsAsInboxUnread = (thread: MailThread) => thread.folder === 'inbox' && thread.unread && !thread.screened

/** The basis a complete publish gives, or null when it carried no whole-Inbox count. */
export function unreadBasis(total: number | undefined, window: readonly MailThread[]): UnreadBasis | null {
  if (total === undefined) return null
  return { total, window: new Set(window.map((t) => t.id)), inWindow: window.filter(countsAsInboxUnread).length }
}

/** Unread Inbox conversations: the engine's count, moved by local changes to its window since. */
export function inboxUnreadCount(list: readonly MailThread[], basis: UnreadBasis | null): number {
  if (!basis) return list.filter(countsAsInboxUnread).length
  const now = list.filter((t) => basis.window.has(t.id) && countsAsInboxUnread(t)).length
  return Math.max(0, basis.total - basis.inWindow + now)
}
