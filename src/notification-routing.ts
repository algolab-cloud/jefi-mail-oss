import type { CalendarEvent } from './engine'

/** Resolve a notification against the current snapshot, then the engine's exact thread lookup. */
export async function resolveNotificationThread<T extends { id: string }>(
  request: string,
  threads: readonly T[],
  load: (id: string) => Promise<T | null>,
): Promise<T | null> {
  return threads.find((thread) => thread.id === request) ?? load(request)
}

/** Synced conversation ids are account-qualified; use that binding when an account is removed. */
export function notificationRequestBelongsToAccount(request: string | null, accountId: string) {
  return !!request && request.startsWith(`${accountId}:`)
}

/**
 * What the calendar should show for a reminder's banner: the occurrence it was about (by key, so a
 * series opens that occurrence's card), or null when the event is gone.
 */
export async function resolveNotificationEvent(route: { eventId: string; occurrenceStart: number }, load: (id: string) => Promise<CalendarEvent | null>) {
  const event = await load(route.eventId)
  if (!event) return null
  const recurring = !!event.recurrence
  return {
    id: event.id,
    startAt: recurring ? route.occurrenceStart : event.startAt,
    allDay: event.allDay,
    recurrence: event.recurrence,
    key: recurring ? `${event.id}@${route.occurrenceStart}` : event.id,
  }
}
