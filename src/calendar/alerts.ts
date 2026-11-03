import type { Reminder, ReminderDefaults } from '../engine'
import { allDayToLocal, startOfDay } from './dates'

// ---------------------------------------------------------------------------
// Event alerts on the UI side: the presets the editor and Settings offer, their wording, and what a
// reminder banner says. Minutes are CalendarEvent.alarms minutes: before the start, and for an
// all-day event before local midnight of its first day (-540 is 9:00 on the day).
// ---------------------------------------------------------------------------

/** A setting's alert: minutes, or null for none. */
export type AlertSetting = number | null

export const TIMED_ALERTS: number[] = [0, 5, 10, 15, 30, 60, 1440]
export const ALL_DAY_ALERTS: number[] = [-540, 900, 2340]

/** "10 minutes before", "At time of event", "9:00 the day before". */
export function alertLabel(minutes: number, allDay: boolean): string {
  if (allDay) {
    const days = Math.ceil(minutes / 1440)
    const time = ((-minutes % 1440) + 1440) % 1440
    const clock = `${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}`
    if (days <= 0) return `On the day at ${clock}`
    return days === 1 ? `The day before at ${clock}` : `${days} days before at ${clock}`
  }
  if (minutes === 0) return 'At time of event'
  const after = minutes < 0
  const m = Math.abs(minutes)
  const amount = m % 1440 === 0 ? plural(m / 1440, 'day') : m % 60 === 0 ? plural(m / 60, 'hour') : plural(m, 'minute')
  return `${amount} ${after ? 'after' : 'before'}`
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

export const alertsLabel = (alarms: number[], allDay: boolean) => (alarms.length ? alarms.map((m) => alertLabel(m, allDay)).join(', ') : 'None')

/** The engine's defaults from the settings: events timed and all-day, then tasks with a due time or date. */
export const reminderDefaults = (timed: AlertSetting, allDay: AlertSetting, taskTimed: AlertSetting = null, taskAllDay: AlertSetting = null): ReminderDefaults => ({
  timed: timed === null ? [] : [timed],
  allDay: allDay === null ? [] : [allDay],
  taskTimed: taskTimed === null ? [] : [taskTimed],
  taskAllDay: taskAllDay === null ? [] : [taskAllDay],
})

/** "At the due time", "30 minutes before", "On the day at 9:00": a task reminder's wording. */
export const taskAlertLabel = (minutes: number, allDay: boolean) => (!allDay && minutes === 0 ? 'At the due time' : alertLabel(minutes, allDay))

// --- The editor's Alert field -----------------------------------------------------------------
// Select values are strings: 'default' (null: follow Settings), '' (none) or comma-separated minutes.

export const encodeAlarms = (alarms: number[] | null) => (alarms === null ? 'default' : alarms.join(','))
export const decodeAlarms = (value: string): number[] | null => (value === 'default' ? null : value ? value.split(',').map(Number) : [])

export function alertOptions(alarms: number[] | null, allDay: boolean, fallback: AlertSetting): Array<{ value: string; label: string }> {
  const options = [
    { value: 'default', label: `Default (${fallback === null ? 'none' : alertLabel(fallback, allDay).toLowerCase()})` },
    { value: '', label: 'None' },
    ...(allDay ? ALL_DAY_ALERTS : TIMED_ALERTS).map((m) => ({ value: String(m), label: alertLabel(m, allDay) })),
  ]
  // An invite's own alerts, or several: kept as they are and shown as one choice.
  const current = encodeAlarms(alarms)
  if (!options.some((o) => o.value === current)) options.push({ value: current, label: alertsLabel(alarms ?? [], allDay) })
  return options
}

// --- Reminder banners -------------------------------------------------------------------------

/** When the event starts, from `now`: "in 10 min", "in 1 hr 30 min", "now", "today", "tomorrow". */
export function startsIn(reminder: Pick<Reminder, 'startAt' | 'allDay'>, now: number): string {
  if (reminder.allDay) {
    const days = Math.round((startOfDay(allDayToLocal(reminder.startAt)) - startOfDay(now)) / 86_400_000)
    if (days <= 0) return 'today'
    return days === 1 ? 'tomorrow' : `in ${days} days`
  }
  const minutes = Math.round((reminder.startAt - now) / 60_000)
  if (minutes <= 0) return minutes < -1 ? `started ${-minutes} min ago` : 'now'
  if (minutes < 60) return `in ${minutes} min`
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60)
    return `in ${h} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  }
  const days = Math.round(minutes / 1440)
  return days === 1 ? 'tomorrow' : `in ${days} days`
}

/** What a reminder's banner and toast say: the title, then "in 10 min · Boardroom" (a task's: "Due in 10 min"). */
export function reminderCopy(reminder: Reminder, now: number): { title: string; body: string } {
  if (reminder.kind === 'task') {
    // "started 5 min ago" is an event's; a task "was due 5 min ago".
    const due = startsIn(reminder, now)
    return { title: reminder.title.trim() || 'Task', body: due.startsWith('started ') ? `Was due ${due.slice(8)}` : `Due ${due}` }
  }
  const title = reminder.title.trim() || 'Event'
  return { title, body: [startsIn(reminder, now), reminder.location?.trim()].filter(Boolean).join(' · ') }
}

/** One key per occurrence and alert, for a toast id and a notification identifier. */
export const reminderKey = (r: Pick<Reminder, 'eventId' | 'occurrenceStart' | 'fireAt'>) => `${r.eventId}@${r.occurrenceStart}@${r.fireAt}`
