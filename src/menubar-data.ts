import { useSyncExternalStore } from 'react'
import type { InviteSummary } from './engine'

// ---------------------------------------------------------------------------
// What the menu bar panel shows besides the calendar: invitations waiting for an answer
// (usePendingInvites in local-data.ts, from engine.pendingInvites) and the recent notifications.
// Recent is a small buffer, newest first, of what Jefi announced: new mail and new invites (store.tsx,
// local-data.ts) and event reminders (pushRecent). It records whether or not a banner was shown, since
// the panel lists them either way. It lives outside React so any module can push to it.
// ---------------------------------------------------------------------------

export type { InviteSummary }

/** Where activating a recent item goes: a conversation, or an event. */
export type RecentRoute = { accountId: string; threadId: string } | { eventId: string; occurrenceStart: number }

export type RecentItem = {
  /** Stable per thing announced ('mail:<threadId>', 'invite:<eventId>', 'reminder:<eventId>@<start>'): a repeat replaces it. */
  id: string
  kind: 'mail' | 'invite' | 'reminder'
  /** One line: the sender, or the event's title. */
  title: string
  /** One line: the subject, or when the event is. */
  subtitle: string
  /** When it was announced (ms). */
  at: number
  route: RecentRoute
  /** The sign-in code the mail brought, for the panel's Sign-in codes list. */
  code?: string
}

export type RecentState = {
  /** Newest first, at most RECENT_CAP. */
  items: RecentItem[]
  /** How many were announced after the last markSeen (for a dot on the status item). */
  unseen: number
  /** When the panel last showed them. */
  seenAt: number
}

export const RECENT_CAP = 10

/** `item` added in front; an older item with the same id is dropped, and the list is capped. */
const sameThread = (a: RecentItem, b: RecentItem) =>
  'threadId' in a.route && 'threadId' in b.route && a.route.threadId === b.route.threadId && a.route.accountId === b.route.accountId
/** How close a new-mail entry and an invitation on the same conversation must be to count as one arrival. */
const SAME_ARRIVAL_MS = 10 * 60_000

export function addRecent(items: RecentItem[], item: RecentItem, cap = RECENT_CAP): RecentItem[] {
  // An invitation arrives as mail too; list it once, as the invitation (either may be announced first).
  const pair = (other: RecentItem) => sameThread(item, other) && Math.abs(item.at - other.at) < SAME_ARRIVAL_MS
  if (item.kind === 'mail' && items.some((i) => i.kind === 'invite' && pair(i))) return items
  const rest = items.filter((i) => i.id !== item.id && !(item.kind === 'invite' && i.kind === 'mail' && pair(i)))
  return [item, ...rest].slice(0, cap)
}

const unseenOf = (items: RecentItem[], seenAt: number) => items.filter((i) => i.at > seenAt).length

/** A recent-notifications buffer; the app uses the one below, tests make their own. */
export function createRecentBuffer(cap = RECENT_CAP) {
  let state: RecentState = { items: [], unseen: 0, seenAt: 0 }
  const listeners = new Set<() => void>()
  const set = (next: RecentState) => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    push(item: RecentItem) {
      const items = addRecent(state.items, item, cap)
      set({ ...state, items, unseen: unseenOf(items, state.seenAt) })
    },
    /** The panel showed them: none is new any more. */
    markSeen(now = Date.now()) {
      if (!state.unseen && state.seenAt >= now) return
      set({ ...state, unseen: 0, seenAt: Math.max(now, ...state.items.map((i) => i.at)) })
    },
    clear() {
      if (state.items.length) set({ ...state, items: [], unseen: 0 })
    },
  }
}

const recent = createRecentBuffer()

/** Records something Jefi announced (the reminders scheduler calls this with kind 'reminder'). */
export const pushRecent = (item: RecentItem) => recent.push(item)
export const markRecentSeen = (now?: number) => recent.markSeen(now)
export const clearRecent = () => recent.clear()
export const recentNotifications = () => recent.get()

/** The recent notifications, newest first, and how many are unseen; a new object only when they change. */
export const useRecentNotifications = (): RecentState => useSyncExternalStore(recent.subscribe, recent.get)

/** A recent item for an invitation that just arrived. */
export const inviteRecent = (invite: InviteSummary, at: number, locale?: string): RecentItem => ({
  id: `invite:${invite.eventId}`,
  kind: 'invite',
  title: invite.title,
  subtitle: `Invitation from ${invite.organizer?.name || invite.organizer?.email || 'someone'} · ${new Date(invite.startAt).toLocaleString(locale, invite.allDay ? { dateStyle: 'medium', timeZone: 'UTC' } : { dateStyle: 'medium', timeStyle: 'short' })}`,
  at,
  route: { accountId: invite.accountId, threadId: invite.threadId },
})

/** Invitations in `next` that weren't in `prev` (by event); none on the first load, which is not news. */
export function arrivedInvites(prev: InviteSummary[] | null, next: InviteSummary[]): InviteSummary[] {
  if (!prev) return []
  const known = new Set(prev.map((i) => i.eventId))
  return next.filter((i) => !known.has(i.eventId))
}
