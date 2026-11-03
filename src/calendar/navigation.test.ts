import { expect, test } from 'bun:test'
import { calendarActionFor } from './keys'
import { prefillFromInput } from './draft'
import { calendarState, showEvent } from './state'

test('calendar keys: only with nothing typed or open, never with a command key', () => {
  const idle = { typing: false, busy: false }
  expect(['t', 'j', 'right', 'k', 'left', 'n', 'c', 'd', '1', 'w', '2', 'm', '3', 'a', '4', 'escape'].map((key) => calendarActionFor({ key }, idle))).toEqual([
    'today', 'next', 'next', 'previous', 'previous', 'new', 'new', 'day', 'day', 'week', 'week', 'month', 'month', 'agenda', 'agenda', 'close',
  ])
  expect(calendarActionFor({ key: 't' }, { typing: true, busy: false })).toBeNull()
  expect(calendarActionFor({ key: 't' }, { typing: false, busy: true })).toBeNull()
  expect(calendarActionFor({ key: 'n', modifiers: { cmd: true } }, idle)).toBeNull()
  expect(calendarActionFor({ key: 'e' }, idle)).toBeNull()
})

test('the reader’s quick-add input becomes a prefill, all-day dates as local days', () => {
  const link = { kind: 'message' as const, accountId: 'a', messageId: 'a:t-1' }
  expect(prefillFromInput({ title: 'Trip', allDay: true, startAt: Date.UTC(2026, 9, 3), endAt: Date.UTC(2026, 9, 5), links: [link] })).toMatchObject({
    title: 'Trip',
    allDay: true,
    start: new Date(2026, 9, 3).getTime(),
    end: new Date(2026, 9, 5).getTime(),
    link,
  })
})

test('showing an event moves the calendar to its day with its card open; a series opens without one', () => {
  showEvent({ id: 'evt-9', startAt: new Date(2026, 9, 3, 15).getTime(), allDay: false, recurrence: null })
  expect([calendarState().cursor, calendarState().selected]).toEqual([new Date(2026, 9, 3, 15).getTime(), 'evt-9'])
  showEvent({ id: 'evt-8', startAt: Date.UTC(2026, 9, 4), allDay: true, recurrence: 'FREQ=DAILY' })
  expect([calendarState().cursor, calendarState().selected]).toEqual([new Date(2026, 9, 4).getTime(), null])
})
