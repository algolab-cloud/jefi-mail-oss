import { useMemo } from 'react'
import { useNow } from '../calendar/hooks'
import { usePendingInvites } from '../local-data'
import { useRecentNotifications, type RecentItem as RecentEntry } from '../menubar-data'
import type { InviteSummary, RecentItem } from './model'

// ---------------------------------------------------------------------------
// The panel's two feeds, from the app's own data: the recent-notifications buffer (new mail, new
// invitations, reminders; src/menubar-data.ts) and the invitations still waiting for an answer.
// ---------------------------------------------------------------------------

export type MenuBarFeeds = { recent: readonly RecentItem[]; pendingInvites: readonly InviteSummary[] }

const toRecent = (entry: RecentEntry): RecentItem => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  detail: entry.subtitle,
  at: entry.at,
  ...(entry.code ? { code: entry.code } : {}),
  route: 'eventId' in entry.route ? { type: 'event', eventId: entry.route.eventId, occurrenceStart: entry.route.occurrenceStart } : { type: 'thread', accountId: entry.route.accountId, threadId: entry.route.threadId },
})

export function useMenuBarFeeds(): MenuBarFeeds {
  const { items } = useRecentNotifications()
  const invites = usePendingInvites(useNow())
  const recent = useMemo(() => items.map(toRecent), [items])
  const pendingInvites = useMemo(
    () => invites.map((i): InviteSummary => ({ eventId: i.eventId, title: i.title, start: i.startAt, allDay: i.allDay, organizer: i.organizer ? i.organizer.name || i.organizer.email : '' })),
    [invites],
  )
  return { recent, pendingInvites }
}
