import type { MailDatabase } from '../db'
import { epochOf } from './recurrence'
import { listEvents, localTimeZone } from './store'
import type { EventOccurrence, Reminder, ReminderDefaults } from './types'

/** An open task with a due, as the scheduler needs it. */
type DueTask = { id: string; number: number; title: string; due_at: number; due_all_day: number; alarms_json: string | null }

// ---------------------------------------------------------------------------
// Event reminders, planned in the engine worker so they fire while the window is hidden. One timer
// at a time points at the next due alert. Every calendar change, wake from sleep and change of the
// defaults re-plans. A reminder fires once (reminders_fired), and only while it's fresh: after a
// sleep or a clock jump, alerts older than FRESH_MS are dropped rather than shown in a burst.
// ---------------------------------------------------------------------------

/** Until the UI says otherwise: 10 minutes before, and 9:00 on the day of an all-day event. */
export const DEFAULT_REMINDERS: ReminderDefaults = { timed: [10], allDay: [-540] }

/** How late a reminder may still be shown: a wake from sleep shows the last few minutes, not the night. */
export const FRESH_MS = 5 * 60_000
/** Longest the timer sleeps before looking again, so a clock set back or forward is caught soon. */
export const MAX_WAIT_MS = 15 * 60_000
const DAY_MS = 86_400_000
/** Fired rows are kept this long: longer than any alert can be re-planned for. */
const KEEP_FIRED_MS = 14 * DAY_MS

/** The instant an alert `minutes` before this occurrence is due. All-day ones count from local midnight. */
export function fireTime(occurrence: Pick<EventOccurrence, 'startAt' | 'allDay'>, minutes: number, zone: string): number {
  if (!occurrence.allDay) return occurrence.startAt - minutes * 60_000
  const d = new Date(occurrence.startAt)
  const midnight = epochOf({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: 0, mi: 0, s: 0 }, zone)
  return midnight - minutes * 60_000
}

const alarmsOf = (e: Pick<EventOccurrence, 'alarms' | 'allDay'>, defaults: ReminderDefaults) => e.alarms ?? (e.allDay ? defaults.allDay : defaults.timed)

/** The widest lead and lag any alert has, so the occurrence window covers every alert due in a range. */
function reach(db: MailDatabase, defaults: ReminderDefaults) {
  const all = [...defaults.timed, ...defaults.allDay, 0]
  all.push(...(defaults.taskTimed ?? []), ...(defaults.taskAllDay ?? []))
  const own = db.query("SELECT DISTINCT alarms_json FROM events WHERE alarms_json IS NOT NULL UNION SELECT DISTINCT alarms_json FROM tasks WHERE alarms_json IS NOT NULL AND status IN ('backlog', 'todo', 'in_progress')").all() as Array<{ alarms_json: string }>
  for (const { alarms_json } of own) all.push(...(JSON.parse(alarms_json) as number[]))
  return { lead: Math.max(...all) * 60_000, lag: Math.max(0, -Math.min(...all)) * 60_000 }
}

/** Every reminder due in [from, to), by time: visible calendars, not cancelled, not declined. */
export function remindersBetween(db: MailDatabase, from: number, to: number, defaults: ReminderDefaults, zone = localTimeZone()): Reminder[] {
  const { lead, lag } = reach(db, defaults)
  // A day of slack either side: an all-day occurrence's local midnight is up to 14h off its UTC one.
  const occurrences = listEvents(db, from - lag - DAY_MS, to + lead + DAY_MS)
  const out: Reminder[] = []
  for (const o of occurrences) {
    for (const minutes of alarmsOf(o, defaults)) {
      const fireAt = fireTime(o, minutes, zone)
      if (fireAt < from || fireAt >= to) continue
      out.push({
        eventId: o.id,
        occurrenceStart: o.occurrenceStart,
        title: o.title,
        location: o.location,
        startAt: o.startAt,
        endAt: o.endAt,
        allDay: o.allDay,
        recurring: o.recurring,
        minutesBefore: minutes,
        fireAt,
      })
    }
  }
  out.push(...taskReminders(db, from, to, defaults, zone, lead, lag))
  return out.sort((a, b) => a.fireAt - b.fireAt || a.startAt - b.startAt)
}

/** Reminders for open tasks due in reach of [from, to): at their own alerts, or the person's default for their kind. */
function taskReminders(db: MailDatabase, from: number, to: number, defaults: ReminderDefaults, zone: string, lead: number, lag: number): Reminder[] {
  const tasks = db
    .query("SELECT id, number, title, due_at, due_all_day, alarms_json FROM tasks WHERE status IN ('backlog', 'todo', 'in_progress') AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?")
    .all(from - lag - DAY_MS, to + lead + DAY_MS) as DueTask[]
  const out: Reminder[] = []
  for (const t of tasks) {
    const allDay = t.due_all_day === 1
    const alarms = t.alarms_json !== null ? (JSON.parse(t.alarms_json) as number[]) : ((allDay ? defaults.taskAllDay : defaults.taskTimed) ?? [])
    for (const minutes of alarms) {
      const fireAt = fireTime({ startAt: t.due_at, allDay }, minutes, zone)
      if (fireAt < from || fireAt >= to) continue
      out.push({ kind: 'task', eventId: t.id, occurrenceStart: t.due_at, title: t.title, location: null, startAt: t.due_at, endAt: t.due_at, allDay, recurring: false, minutesBefore: minutes, fireAt })
    }
  }
  return out
}

/** Claims a reminder: true the first time only, so it's shown once however often it's planned. */
export function claimReminder(db: MailDatabase, r: Pick<Reminder, 'eventId' | 'occurrenceStart' | 'fireAt'>, now: number): boolean {
  return db.run('INSERT OR IGNORE INTO reminders_fired (event_id, occurrence_start, fire_at, fired_at) VALUES (?, ?, ?, ?)', [r.eventId, r.occurrenceStart, r.fireAt, now]).changes > 0
}

export type ReminderClock = {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** The zone all-day alerts are placed in; the person's. */
  zone: () => string
}

const realClock: ReminderClock = {
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  zone: localTimeZone,
}

/**
 * The reminder loop. Nothing runs until `start` (the UI sends its defaults at launch), so an engine
 * made for a test or a one-off never opens its database for reminders.
 */
export function createReminderScheduler(options: { db: () => MailDatabase; onDue: (reminder: Reminder) => void; clock?: Partial<ReminderClock> }) {
  const clock = { ...realClock, ...options.clock }
  let defaults: ReminderDefaults | null = null
  let timer: unknown = null
  let queued = false
  let stopped = false

  const run = () => {
    queued = false
    if (stopped || !defaults) return
    if (timer !== null) clock.clearTimer(timer)
    timer = null
    const now = clock.now()
    let wait = MAX_WAIT_MS
    try {
      const db = options.db()
      for (const r of remindersBetween(db, now - FRESH_MS, now + 1, defaults, clock.zone())) {
        if (claimReminder(db, r, now)) options.onDue(r)
      }
      db.run('DELETE FROM reminders_fired WHERE fire_at < ?', [now - KEEP_FIRED_MS])
      const next = remindersBetween(db, now + 1, now + MAX_WAIT_MS, defaults, clock.zone())[0]
      if (next) wait = Math.max(0, next.fireAt - now)
    } catch (err) {
      // A bad row or a busy database must not stop reminders for good: try again on the next pass.
      console.warn(`reminders: ${(err as Error)?.message ?? err}`)
    }
    timer = clock.setTimer(run, wait)
  }

  return {
    /** Starts, or re-plans with new defaults. */
    start(next: ReminderDefaults) {
      defaults = { timed: [...next.timed], allDay: [...next.allDay], taskTimed: [...(next.taskTimed ?? [])], taskAllDay: [...(next.taskAllDay ?? [])] }
      run()
    },
    /** Re-plan soon: calendar changes arrive in bursts, one pass covers them all. */
    replan() {
      if (queued || stopped || !defaults) return
      queued = true
      queueMicrotask(run)
    },
    /** Re-plan now (tests, wake). */
    runNow: run,
    stop() {
      stopped = true
      if (timer !== null) clock.clearTimer(timer)
      timer = null
    },
  }
}
