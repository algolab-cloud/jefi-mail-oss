import { expect, test } from 'bun:test'
import type { Reminder } from '../engine'
import { alertLabel, alertOptions, decodeAlarms, encodeAlarms, reminderCopy, reminderDefaults, startsIn, taskAlertLabel } from './alerts'
import { draftFromEvent, draftFromPrefill, draftToInput } from './draft'

const MIN = 60_000

test('alerts read the way people say them', () => {
  expect([0, 5, 10, 60, 90, 1440, -30].map((m) => alertLabel(m, false))).toEqual([
    'At time of event',
    '5 minutes before',
    '10 minutes before',
    '1 hour before',
    '90 minutes before',
    '1 day before',
    '30 minutes after',
  ])
  expect([-540, 900, 2340].map((m) => alertLabel(m, true))).toEqual(['On the day at 9:00', 'The day before at 9:00', '2 days before at 9:00'])
})

test('the editor’s Alert field: default, none, presets, and an invite’s own alerts kept', () => {
  expect([null, [], [10], [15, 60]].map((a) => decodeAlarms(encodeAlarms(a)))).toEqual([null, [], [10], [15, 60]])
  const timed = alertOptions(null, false, 10)
  expect(timed.map((o) => o.label)).toEqual([
    'Default (10 minutes before)',
    'None',
    'At time of event',
    '5 minutes before',
    '10 minutes before',
    '15 minutes before',
    '30 minutes before',
    '1 hour before',
    '1 day before',
  ])
  expect(alertOptions([15, 60], false, null).at(-1)).toEqual({ value: '15,60', label: '15 minutes before, 1 hour before' })
  expect(alertOptions(null, true, null)[0]!.label).toBe('Default (none)')
  expect(reminderDefaults(10, null)).toEqual({ timed: [10], allDay: [], taskTimed: [], taskAllDay: [] })
  expect(reminderDefaults(10, -540, 30, null)).toEqual({ timed: [10], allDay: [-540], taskTimed: [30], taskAllDay: [] })
})

test('a draft keeps the event’s alerts and hands them back', () => {
  const blank = draftFromPrefill({}, { calendarId: 'local', now: 0 })
  expect(draftToInput(blank).alarms).toBeNull()
  expect(draftToInput({ ...blank, alarms: [30] }).alarms).toEqual([30])
  const event = { ...draftToInput({ ...blank, alarms: [] }), id: 'e', uid: 'u', sequence: 0, accountId: null, timeZone: null, url: null, status: 'confirmed' as const, organizer: null, exdates: [], recurringMasterId: null, recurrenceId: null, invite: null, createdAt: 0, updatedAt: 0, allDay: false, calendarId: 'local', location: null, description: null, recurrence: null, attendees: [], alarms: [5] }
  expect(draftFromEvent(event).alarms).toEqual([5])
})

const reminder = (patch: Partial<Reminder> = {}): Reminder => ({
  eventId: 'e',
  occurrenceStart: 0,
  title: 'Board dry run',
  location: 'Boardroom',
  startAt: 10 * MIN,
  endAt: 70 * MIN,
  allDay: false,
  recurring: false,
  minutesBefore: 10,
  fireAt: 0,
  ...patch,
})

test('a reminder banner says what, when and where', () => {
  expect(reminderCopy(reminder(), 0)).toEqual({ title: 'Board dry run', body: 'in 10 min · Boardroom' })
  expect(reminderCopy(reminder({ location: null, title: ' ' }), 10 * MIN)).toEqual({ title: 'Event', body: 'now' })
  expect(startsIn(reminder({ startAt: 90 * MIN }), 0)).toBe('in 1 hr 30 min')
  expect(startsIn(reminder({ startAt: 2 * 60 * MIN }), 0)).toBe('in 2 hr')
  expect(startsIn(reminder({ startAt: 24 * 60 * MIN }), 0)).toBe('tomorrow')
  expect(startsIn(reminder({ startAt: 0 }), 3 * MIN)).toBe('started 3 min ago')
})

test('an all-day reminder names the day', () => {
  const now = new Date(2026, 2, 11, 9).getTime()
  expect(startsIn(reminder({ allDay: true, startAt: Date.UTC(2026, 2, 11) }), now)).toBe('today')
  expect(startsIn(reminder({ allDay: true, startAt: Date.UTC(2026, 2, 12) }), now)).toBe('tomorrow')
  expect(startsIn(reminder({ allDay: true, startAt: Date.UTC(2026, 2, 14) }), now)).toBe('in 3 days')
})

test('task reminders read as due times', () => {
  const now = Date.UTC(2026, 8, 26, 10)
  const task = { kind: 'task' as const, eventId: 'task-1', occurrenceStart: now, title: ' Send the deck ', location: null, startAt: now + 30 * 60_000, endAt: now, allDay: false, recurring: false, minutesBefore: 30, fireAt: now }
  expect(reminderCopy(task, now)).toEqual({ title: 'Send the deck', body: 'Due in 30 min' })
  expect(reminderCopy({ ...task, startAt: now }, now).body).toBe('Due now')
  expect(reminderCopy({ ...task, startAt: now - 5 * 60_000 }, now).body).toBe('Was due 5 min ago')
  expect(taskAlertLabel(0, false)).toBe('At the due time')
  expect(taskAlertLabel(60, false)).toBe('1 hour before')
  expect(taskAlertLabel(-540, true)).toBe('On the day at 9:00')
})
