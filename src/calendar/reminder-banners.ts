import type { Reminder } from '../engine'
import { appIsActive, EVENT_IMAGE, showEventNotification, TASK_IMAGE, type EventRoute } from '../native/notify'
import { pushRecent } from '../menubar-data'
import { toast } from '../toast'
import { reminderCopy, reminderKey } from './alerts'

// ---------------------------------------------------------------------------
// A due reminder (the engine's reminderDue event) as the person sees it: a toast in the app, and a
// Notification Center banner while Jefi is behind another app or hidden. Both open the occurrence.
// ---------------------------------------------------------------------------

/** Called once for every reminder shown: the menu bar's recent list keeps it. */
export function onReminderShown(reminder: Reminder, now = Date.now()) {
  const { title, body } = reminderCopy(reminder, now)
  pushRecent({ id: `reminder:${reminder.eventId}@${reminder.occurrenceStart}`, kind: 'reminder', title, subtitle: body, at: now, route: { eventId: reminder.eventId, occurrenceStart: reminder.occurrenceStart } })
}

export function announceReminder(reminder: Reminder, open: (route: EventRoute) => void, now = Date.now()) {
  const { title, body } = reminderCopy(reminder, now)
  const route = { eventId: reminder.eventId, occurrenceStart: reminder.occurrenceStart }
  toast.info(title, { id: `reminder-${reminderKey(reminder)}`, description: body, duration: 15_000, action: { label: 'Open', onClick: () => open(route) } })
  if (!appIsActive()) showEventNotification({ ...route, title, body, image: reminder.kind === 'task' ? TASK_IMAGE : EVENT_IMAGE })
  onReminderShown(reminder, now)
}
