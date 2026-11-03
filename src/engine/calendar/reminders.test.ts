import { afterEach, expect, test } from 'bun:test'
import { parseIcs } from '../../detect/ics'
import { openDatabase, type MailDatabase } from '../db'
import { createImapEngine } from '../imap-engine'
import type { SecretStore } from '../secrets'
import type { EngineEvent } from '../types'
import { writeCalendar } from './ics-write'
import { FRESH_MS, MAX_WAIT_MS, createReminderScheduler, fireTime, remindersBetween, type ReminderClock } from './reminders'
import { createLocalCalendar, deleteEvent, getEvent, saveEvent, updateCalendar } from './store'
import { saveTask } from './tasks'
import type { Reminder, ReminderDefaults } from './types'

// Reminders against a fake clock: timers run only when the test lets time pass, and a jump moves
// the clock without running them, the way a sleeping Mac or a clock being set does.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 2, 10, 8, 0)
const DEFAULTS: ReminderDefaults = { timed: [10], allDay: [-540] }

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function fakeClock(start: number, zone = 'UTC') {
  let now = start
  let seq = 0
  let timers: Array<{ id: number; at: number; fn: () => void }> = []
  const clock: ReminderClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.push({ id, at: now + ms, fn })
      return id
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id)
    },
    zone: () => zone,
  }
  return {
    clock,
    now: () => now,
    /** Time passes with the Mac awake: timers run as they come due. */
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers = timers.filter((t) => t !== next)
        now = Math.max(now, next.at)
        next.fn()
      }
      now = end
    },
    /** The clock moves and no timer runs: sleep, or someone setting the time. */
    jump(to: number) {
      now = to
    },
    nextTimer: () => Math.min(...timers.map((t) => t.at)),
  }
}

function setup(start = T0, zone = 'UTC') {
  const db = openDatabase(':memory:')
  const time = fakeClock(start, zone)
  const fired: Reminder[] = []
  const scheduler = createReminderScheduler({ db: () => db, onDue: (r) => fired.push(r), clock: time.clock })
  cleanups.push(() => scheduler.stop(), () => db.close())
  return { db, time, fired, scheduler }
}

const timed = (db: MailDatabase, title: string, startAt: number, extra: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
  saveEvent(db, { title, startAt, endAt: startAt + HOUR, timeZone: 'UTC', ...extra })

test('a reminder fires once, at its time, with what the banner shows', () => {
  const { db, time, fired, scheduler } = setup()
  const event = timed(db, 'Board dry run', T0 + 20 * MIN, { location: 'Boardroom' })
  scheduler.start(DEFAULTS)
  expect(fired).toEqual([])
  // One timer, aimed at the alert rather than polling.
  expect(time.nextTimer()).toBe(T0 + 10 * MIN)
  time.advance(10 * MIN - 1)
  expect(fired).toEqual([])
  time.advance(1)
  expect(fired).toEqual([
    {
      eventId: event.id,
      occurrenceStart: T0 + 20 * MIN,
      title: 'Board dry run',
      location: 'Boardroom',
      startAt: T0 + 20 * MIN,
      endAt: T0 + 80 * MIN,
      allDay: false,
      recurring: false,
      minutesBefore: 10,
      fireAt: T0 + 10 * MIN,
    },
  ])
  time.advance(2 * HOUR)
  scheduler.runNow()
  expect(fired.length).toBe(1)
})

test('with nothing due soon the timer still wakes within MAX_WAIT_MS', () => {
  const { time, scheduler } = setup()
  scheduler.start(DEFAULTS)
  expect(time.nextTimer()).toBe(T0 + MAX_WAIT_MS)
})

test('an event’s own alerts replace the default; [] is none; several fire in order', () => {
  const { db, time, fired, scheduler } = setup()
  timed(db, 'Quiet', T0 + 30 * MIN, { alarms: [] })
  const loud = timed(db, 'Loud', T0 + 2 * HOUR, { alarms: [60, 5, 60] })
  expect(getEvent(db, loud.id)!.alarms).toEqual([5, 60])
  scheduler.start(DEFAULTS)
  time.advance(3 * HOUR)
  expect(fired.map((r) => [r.title, r.minutesBefore, r.fireAt])).toEqual([
    ['Loud', 60, T0 + HOUR],
    ['Loud', 5, T0 + 115 * MIN],
  ])
})

test('each occurrence of a series is reminded, skipping removed ones and exceptions follow their own time', () => {
  const { db, time, fired, scheduler } = setup()
  const start = T0 + HOUR
  const series = timed(db, 'Standup', start, { recurrence: 'FREQ=DAILY;COUNT=4' })
  deleteEvent(db, series.id, 'this', start + DAY)
  // The third one moved an hour later.
  saveEvent(db, { id: series.id, title: 'Standup (late)', startAt: start + 2 * DAY + HOUR, endAt: start + 2 * DAY + 2 * HOUR }, { scope: 'this', occurrenceStart: start + 2 * DAY })
  scheduler.start(DEFAULTS)
  time.advance(5 * DAY)
  expect(fired.map((r) => [r.title, r.occurrenceStart, r.fireAt, r.recurring])).toEqual([
    ['Standup', start, start - 10 * MIN, true],
    ['Standup (late)', start + 2 * DAY, start + 2 * DAY + 50 * MIN, false],
    ['Standup', start + 3 * DAY, start + 3 * DAY - 10 * MIN, true],
  ])
})

test('all-day alerts are on the person’s clock', () => {
  const day = Date.UTC(2026, 2, 12)
  const { db } = setup()
  const event = saveEvent(db, { title: 'Offsite', startAt: day, endAt: day + DAY, allDay: true })
  // 9:00 in Berlin (UTC+1 in March) on the day, and 9:00 the day before.
  expect(fireTime(event, -540, 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 12, 8))
  expect(fireTime(event, 900, 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 11, 8))
  const due = remindersBetween(db, day - DAY, day + DAY, { timed: [], allDay: [-540, 900] }, 'Europe/Berlin')
  expect(due.map((r) => r.fireAt)).toEqual([Date.UTC(2026, 2, 11, 8), Date.UTC(2026, 2, 12, 8)])
  expect(due.every((r) => r.allDay && r.occurrenceStart === day)).toBe(true)
})

test('after a sleep only the last few minutes fire; the night’s stale alerts are dropped', () => {
  const { db, time, fired, scheduler } = setup()
  timed(db, 'Early', T0 + HOUR)
  timed(db, 'Just now', T0 + 3 * HOUR + 12 * MIN)
  timed(db, 'Later', T0 + 5 * HOUR)
  scheduler.start(DEFAULTS)
  // Asleep from T0 to three hours later: no timer ran. Wake re-plans.
  time.jump(T0 + 3 * HOUR + 3 * MIN)
  scheduler.runNow()
  expect(fired.map((r) => r.title)).toEqual(['Just now'])
  time.advance(3 * HOUR)
  expect(fired.map((r) => r.title)).toEqual(['Just now', 'Later'])
  expect(FRESH_MS).toBe(5 * MIN)
})

test('the clock going back, a re-plan or a restart never fires a reminder twice', () => {
  const { db, time, fired, scheduler } = setup()
  timed(db, 'Review', T0 + 20 * MIN)
  scheduler.start(DEFAULTS)
  time.advance(15 * MIN)
  expect(fired.length).toBe(1)
  // Someone sets the clock back half an hour: the alert comes due again and stays quiet.
  time.jump(T0 - 20 * MIN)
  scheduler.runNow()
  time.advance(40 * MIN)
  scheduler.start(DEFAULTS)
  expect(fired.length).toBe(1)
  // A new engine run on the same database, at the same moment.
  const again: Reminder[] = []
  const second = createReminderScheduler({ db: () => db, onDue: (r) => again.push(r), clock: { ...time.clock } })
  time.jump(T0 + 11 * MIN)
  second.start(DEFAULTS)
  second.stop()
  expect(again).toEqual([])
})

test('calendar changes re-plan: a new event, a moved one, a hidden calendar', async () => {
  const { db, time, fired, scheduler } = setup()
  scheduler.start(DEFAULTS)
  expect(time.nextTimer()).toBe(T0 + MAX_WAIT_MS)
  const soon = timed(db, 'Soon', T0 + 15 * MIN)
  scheduler.replan()
  scheduler.replan()
  await Promise.resolve()
  expect(time.nextTimer()).toBe(T0 + 5 * MIN)
  // Moved later before it fires: the old time passes quietly.
  saveEvent(db, { id: soon.id, title: 'Soon', startAt: T0 + HOUR, endAt: T0 + 2 * HOUR })
  scheduler.replan()
  await Promise.resolve()
  time.advance(30 * MIN)
  expect(fired).toEqual([])
  const work = createLocalCalendar(db, { name: 'Work', color: '#f60' })
  timed(db, 'Hidden', T0 + 45 * MIN, { calendarId: work.id })
  updateCalendar(db, work.id, { hidden: true })
  saveEvent(db, { title: 'Cancelled', startAt: T0 + 50 * MIN, endAt: T0 + HOUR, timeZone: 'UTC', status: 'cancelled' })
  time.advance(HOUR)
  expect(fired.map((r) => [r.title, r.fireAt])).toEqual([['Soon', T0 + 50 * MIN]])
})

test('new defaults re-plan, and no defaults means no alerts', () => {
  const { db, time, fired, scheduler } = setup()
  timed(db, 'Sync', T0 + 40 * MIN)
  scheduler.start({ timed: [], allDay: [] })
  time.advance(20 * MIN)
  scheduler.start({ timed: [15], allDay: [] })
  time.advance(HOUR)
  expect(fired.map((r) => r.minutesBefore)).toEqual([15])
})

test('the engine emits reminderDue once the UI starts it, and re-plans on its own calendar changes', async () => {
  const db = openDatabase(':memory:')
  const time = fakeClock(T0)
  const secrets: SecretStore = { get: async () => null, set: async () => {}, delete: async () => {} }
  const engine = createImapEngine({ database: () => db, secrets, watch: false, wake: false, reminderClock: time.clock })
  cleanups.push(() => db.close(), () => engine.dispose())
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  await engine.saveEvent({ title: 'Before start', startAt: T0 + 30 * MIN, endAt: T0 + HOUR, timeZone: 'UTC' })
  time.advance(HOUR)
  // Nothing plans reminders until the UI hands over its defaults.
  expect(events.some((e) => e.type === 'reminderDue')).toBe(false)
  engine.setReminderDefaults(DEFAULTS)
  const event = await engine.saveEvent({ title: 'Board dry run', startAt: T0 + 2 * HOUR, endAt: T0 + 3 * HOUR, timeZone: 'UTC', location: 'Boardroom' })
  await Promise.resolve()
  time.advance(HOUR)
  const due = events.filter((e) => e.type === 'reminderDue')
  expect(due).toEqual([{ type: 'reminderDue', reminder: expect.objectContaining({ eventId: event.id, occurrenceStart: T0 + 2 * HOUR, title: 'Board dry run', location: 'Boardroom', fireAt: T0 + 110 * MIN }) }])
})

// --- VALARM -------------------------------------------------------------------------------------

test('VALARM round trip: alerts written for an event read back as the same minutes', () => {
  const ics = writeCalendar('REQUEST', [
    { uid: 'a@jefi', sequence: 0, title: 'Board, dry run', startAt: T0, endAt: T0 + HOUR, allDay: false, timeZone: 'UTC', alarms: [0, 10, 90, 1440, -30] },
  ])
  expect(ics).toContain('BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Board\\, dry run\r\nTRIGGER:-PT10M\r\nEND:VALARM')
  for (const t of ['TRIGGER:PT0S', 'TRIGGER:-PT1H30M', 'TRIGGER:-P1D', 'TRIGGER:PT30M']) expect(ics).toContain(t)
  expect(parseIcs(ics).events[0]!.alarms).toEqual([-30, 0, 10, 90, 1440])
  const allDay = writeCalendar('REQUEST', [{ uid: 'b@jefi', sequence: 0, title: 'Offsite', startAt: Date.UTC(2026, 2, 12), endAt: Date.UTC(2026, 2, 13), allDay: true, timeZone: null, alarms: [-540, 900] }])
  expect(allDay).toContain('TRIGGER:PT9H')
  expect(allDay).toContain('TRIGGER:-PT15H')
  expect(parseIcs(allDay).events[0]!.alarms).toEqual([-540, 900])
  // No alarms, no VALARM.
  expect(writeCalendar('REQUEST', [{ uid: 'c@jefi', sequence: 0, title: 'x', startAt: T0, endAt: T0 + HOUR, allDay: false, timeZone: 'UTC' }])).not.toContain('VALARM')
})

test('VALARM parsing: relative to the end, absolute, and alarms that aren’t shown are skipped', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x@example.com',
    'DTSTART:20260310T150000Z',
    'DTEND:20260310T160000Z',
    'SUMMARY:Review',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER;RELATED=END:-PT75M',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:AUDIO',
    'TRIGGER;VALUE=DATE-TIME:20260310T143000Z',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:EMAIL',
    'TRIGGER:-PT2H',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:not-a-duration',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  expect(parseIcs(ics).events[0]!.alarms).toEqual([15, 30])
})

test('tasks remind too: at their due time by default, on the day for date-only ones, never once closed', () => {
  const { db, time, fired, scheduler } = setup()
  const call = saveTask(db, { title: 'Call Kenji', dueAt: T0 + 30 * MIN })
  const rent = saveTask(db, { title: 'Pay rent', dueAt: Date.UTC(2026, 2, 10), dueAllDay: true })
  const own = saveTask(db, { title: 'Send the deck', dueAt: T0 + 2 * HOUR, alarms: [60] })
  saveTask(db, { title: 'No reminder', dueAt: T0 + 40 * MIN, alarms: [] })
  const shipped = saveTask(db, { title: 'Shipped', dueAt: T0 + 20 * MIN })
  saveTask(db, { id: shipped.id, status: 'done' })
  scheduler.start({ ...DEFAULTS, taskTimed: [0], taskAllDay: [-540] })
  // 9:00 on the day for the date-only task (UTC here), then the task's own hour before, then the due time.
  time.advance(3 * HOUR)
  expect(fired.map((r) => [r.kind, r.eventId, r.fireAt])).toEqual([
    ['task', call.id, T0 + 30 * MIN],
    ['task', rent.id, Date.UTC(2026, 2, 10, 9)],
    ['task', own.id, T0 + HOUR],
  ])
  expect(fired.find((r) => r.eventId === call.id)).toMatchObject({ title: 'Call Kenji', startAt: T0 + 30 * MIN, minutesBefore: 0, allDay: false })
  // Shown once, however often it's planned.
  scheduler.runNow()
  expect(fired).toHaveLength(3)
})

test('a task change re-plans its reminder', async () => {
  const db = openDatabase(':memory:')
  const time = fakeClock(T0)
  const events: EngineEvent[] = []
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} } as SecretStore, watch: false, wake: false, reminderClock: time.clock })
  cleanups.push(() => engine.dispose(), () => db.close())
  engine.subscribe((batch) => events.push(...batch))
  engine.setReminderDefaults({ ...DEFAULTS, taskTimed: [10] })
  // The timer aims at the next alert within MAX_WAIT_MS (it wakes then anyway otherwise).
  const task = await engine.saveTask({ title: 'Stand-up notes', dueAt: T0 + 14 * MIN })
  await Bun.sleep(0)
  expect(time.nextTimer()).toBe(T0 + 4 * MIN)
  await engine.saveTask({ id: task.id, dueAt: T0 + 12 * MIN })
  await Bun.sleep(0)
  expect(time.nextTimer()).toBe(T0 + 2 * MIN)
  time.advance(2 * MIN)
  expect(events.filter((e) => e.type === 'reminderDue').map((e) => (e as { reminder: Reminder }).reminder.eventId)).toEqual([task.id])
})
