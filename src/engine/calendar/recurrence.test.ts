import { expect, test } from 'bun:test'
import { endBefore, epochOf, expandSeries, formatRRule, parseRRule, seriesEnd } from './recurrence'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (t: number) => new Date(t).toISOString().replace(':00.000Z', 'Z')
const starts = (series: Parameters<typeof expandSeries>[0], from = -Infinity, to = Infinity) => expandSeries(series, from, to).map((o) => iso(o.start))

test('parses the supported subset and writes it back canonically', () => {
  expect(parseRRule('RRULE:freq=weekly;byday=MO,WE;interval=2;count=4')).toEqual({ freq: 'WEEKLY', interval: 2, count: 4, byDay: [1, 3], wkst: 1 })
  expect(formatRRule(parseRRule('FREQ=WEEKLY;COUNT=4;BYDAY=WE,MO;INTERVAL=2'))).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO;COUNT=4')
  expect(formatRRule(parseRRule('FREQ=DAILY;UNTIL=20260310T000000Z'))).toBe('FREQ=DAILY;UNTIL=20260310T000000Z')
})

test('rejects what it cannot expand instead of expanding it wrongly', () => {
  for (const rule of ['FREQ=HOURLY', 'FREQ=MONTHLY;BYDAY=2TU', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;COUNT=2;UNTIL=20260101', 'FREQ=WEEKLY;BYDAY=XX', 'INTERVAL=2', 'FREQ=YEARLY;BYMONTH=3']) {
    expect(() => parseRRule(rule)).toThrow()
  }
})

test('a weekly meeting keeps its wall-clock time across a DST change (America/New_York)', () => {
  // Monday 2 March 2026 09:00 EST; clocks go forward on 8 March.
  const startAt = Date.UTC(2026, 2, 2, 14)
  const series = { startAt, endAt: startAt + HOUR, allDay: false, timeZone: 'America/New_York', recurrence: 'FREQ=WEEKLY;COUNT=3' }
  expect(starts(series)).toEqual(['2026-03-02T14:00Z', '2026-03-09T13:00Z', '2026-03-16T13:00Z'])
  // And back in November (clocks go back on 1 November).
  const fall = Date.UTC(2026, 9, 26, 13)
  expect(starts({ ...series, startAt: fall, endAt: fall + HOUR })).toEqual(['2026-10-26T13:00Z', '2026-11-02T14:00Z', '2026-11-09T14:00Z'])
})

test('times in the spring gap move forward; repeated fall-back times take the first instance (Europe/Berlin)', () => {
  // 29 March 2026: 02:00 → 03:00. A daily 02:30 lands at 03:30 CEST that day.
  const startAt = epochOf({ y: 2026, m: 3, d: 28, h: 2, mi: 30, s: 0 }, 'Europe/Berlin')
  expect(iso(startAt)).toBe('2026-03-28T01:30Z')
  const series = { startAt, endAt: startAt + HOUR, allDay: false, timeZone: 'Europe/Berlin', recurrence: 'FREQ=DAILY;COUNT=3' }
  expect(starts(series)).toEqual(['2026-03-28T01:30Z', '2026-03-29T01:30Z', '2026-03-30T00:30Z'])
  // 25 October 2026: 03:00 → 02:00, so 02:30 happens twice; the first is 02:30 CEST (00:30Z).
  const fall = epochOf({ y: 2026, m: 10, d: 24, h: 2, mi: 30, s: 0 }, 'Europe/Berlin')
  expect(starts({ ...series, startAt: fall, endAt: fall + HOUR })).toEqual(['2026-10-24T00:30Z', '2026-10-25T00:30Z', '2026-10-26T01:30Z'])
})

test('all-day events recur by UTC date, whatever the zone', () => {
  const startAt = Date.UTC(2026, 2, 7)
  const series = { startAt, endAt: startAt + DAY, allDay: true, timeZone: 'America/New_York', recurrence: 'FREQ=DAILY;INTERVAL=2;COUNT=3' }
  expect(expandSeries(series, -Infinity, Infinity)).toEqual([
    { start: Date.UTC(2026, 2, 7), end: Date.UTC(2026, 2, 8) },
    { start: Date.UTC(2026, 2, 9), end: Date.UTC(2026, 2, 10) },
    { start: Date.UTC(2026, 2, 11), end: Date.UTC(2026, 2, 12) },
  ])
  // A date-only UNTIL includes that day.
  expect(starts({ ...series, recurrence: 'FREQ=DAILY;UNTIL=20260309' })).toEqual(['2026-03-07T00:00Z', '2026-03-08T00:00Z', '2026-03-09T00:00Z'])
})

test('UNTIL is inclusive, in UTC or in the event zone', () => {
  const startAt = Date.UTC(2026, 0, 5, 9)
  const series = { startAt, endAt: startAt + HOUR, allDay: false, timeZone: 'UTC', recurrence: 'FREQ=DAILY;UNTIL=20260107T090000Z' }
  expect(starts(series)).toEqual(['2026-01-05T09:00Z', '2026-01-06T09:00Z', '2026-01-07T09:00Z'])
  expect(starts({ ...series, recurrence: 'FREQ=DAILY;UNTIL=20260107T085959Z' })).toEqual(['2026-01-05T09:00Z', '2026-01-06T09:00Z'])
  // Date-only UNTIL on a timed event: through the end of that day in its zone.
  const tokyo = Date.UTC(2026, 0, 5, 0) // 09:00 in Tokyo
  expect(starts({ ...series, startAt: tokyo, endAt: tokyo + HOUR, timeZone: 'Asia/Tokyo', recurrence: 'FREQ=DAILY;UNTIL=20260106' })).toEqual(['2026-01-05T00:00Z', '2026-01-06T00:00Z'])
})

test('weekly BYDAY with an interval, counting from the first occurrence', () => {
  // Wednesday 7 January 2026; Mon/Wed/Fri every other week. The Monday before the start doesn't count.
  const startAt = Date.UTC(2026, 0, 7, 9)
  const series = { startAt, endAt: startAt + HOUR, allDay: false, timeZone: 'UTC', recurrence: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=5' }
  expect(starts(series)).toEqual(['2026-01-07T09:00Z', '2026-01-09T09:00Z', '2026-01-19T09:00Z', '2026-01-21T09:00Z', '2026-01-23T09:00Z'])
  // WKST=SU puts Sunday in the same week as the Monday after it.
  expect(starts({ ...series, recurrence: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE;COUNT=3;WKST=SU' })).toEqual(['2026-01-07T09:00Z', '2026-01-18T09:00Z', '2026-01-21T09:00Z'])
})

test('monthly and yearly skip dates a month or year lacks', () => {
  const jan31 = Date.UTC(2026, 0, 31, 12)
  const monthly = { startAt: jan31, endAt: jan31 + HOUR, allDay: false, timeZone: 'UTC', recurrence: 'FREQ=MONTHLY;COUNT=4' }
  expect(starts(monthly)).toEqual(['2026-01-31T12:00Z', '2026-03-31T12:00Z', '2026-05-31T12:00Z', '2026-07-31T12:00Z'])
  const leap = Date.UTC(2024, 1, 29)
  expect(starts({ startAt: leap, endAt: leap + DAY, allDay: true, timeZone: null, recurrence: 'FREQ=YEARLY;COUNT=2' })).toEqual(['2024-02-29T00:00Z', '2028-02-29T00:00Z'])
})

test('COUNT counts excluded occurrences; the range keeps occurrences that overlap it', () => {
  const startAt = Date.UTC(2026, 0, 1, 23)
  const series = { startAt, endAt: startAt + 2 * HOUR, allDay: false, timeZone: 'UTC', recurrence: 'FREQ=DAILY;COUNT=4', exdates: [Date.UTC(2026, 0, 2, 23)] }
  expect(starts(series)).toEqual(['2026-01-01T23:00Z', '2026-01-03T23:00Z', '2026-01-04T23:00Z'])
  // 3 January's occurrence runs into the 4th, so a range starting on the 4th includes it.
  expect(starts(series, Date.UTC(2026, 0, 4), Date.UTC(2026, 0, 5))).toEqual(['2026-01-03T23:00Z', '2026-01-04T23:00Z'])
  expect(seriesEnd(series)).toBe(Date.UTC(2026, 0, 5, 1))
  expect(seriesEnd({ ...series, recurrence: 'FREQ=DAILY' })).toBeNull()
})

test('an endless series only expands as far as the range asks', () => {
  const startAt = Date.UTC(2000, 0, 1, 9)
  const series = { startAt, endAt: startAt + HOUR, allDay: false, timeZone: 'Europe/London', recurrence: 'FREQ=DAILY' }
  expect(starts(series, Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 3))).toEqual(['2026-07-01T08:00Z', '2026-07-02T08:00Z'])
})

test('endBefore ends a rule just before an occurrence, replacing COUNT', () => {
  expect(endBefore('FREQ=DAILY;COUNT=10', Date.UTC(2026, 0, 5, 9), false)).toBe('FREQ=DAILY;UNTIL=20260105T085959Z')
  expect(endBefore('FREQ=WEEKLY;BYDAY=MO', Date.UTC(2026, 0, 5), true)).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260104')
})
