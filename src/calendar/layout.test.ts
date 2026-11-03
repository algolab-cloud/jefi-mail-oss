import { describe, expect, test } from 'bun:test'
import { DAY, HOUR, MINUTE, addDays, addMonths, allDayToLocal, firstDayOfWeek, localToAllDay, monthGrid, startOfDay, startOfWeek, weekendDays } from './dates'
import { isAllDayLike, layoutDay, layoutRow, monthCellFit, recycleKeys, spanOf, stableKeys } from './layout'

/** Runs `fn` with the process in another time zone (Bun re-reads TZ when it changes). */
function inZone<T>(zone: string, fn: () => T): T {
  const before = process.env.TZ
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

const iso = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('days step by the wall clock across DST, so every day starts at midnight', () => {
  inZone('America/New_York', () => {
    // 8 March 2026 is 23 hours long there, 1 November 25.
    const spring = new Date(2026, 2, 7).getTime()
    expect([0, 1, 2].map((n) => iso(addDays(spring, n)))).toEqual(['2026-03-07 00:00', '2026-03-08 00:00', '2026-03-09 00:00'])
    expect(addDays(spring, 2) - addDays(spring, 1)).toBe(23 * HOUR)
    const fall = new Date(2026, 10, 1, 9, 30).getTime()
    expect(iso(addDays(fall, 1))).toBe('2026-11-02 09:30')
    expect(iso(startOfDay(new Date(2026, 10, 1, 23).getTime()))).toBe('2026-11-01 00:00')
  })
})

test('weeks start on the locale’s first day', () => {
  expect(firstDayOfWeek('en-US')).toBe(0)
  expect(firstDayOfWeek('en-GB')).toBe(1)
  expect(firstDayOfWeek('de-DE')).toBe(1)
  expect(firstDayOfWeek('ar-EG')).toBe(6)
  expect(weekendDays('en-US').sort()).toEqual([0, 6])
  inZone('Europe/Berlin', () => {
    const saturday = new Date(2026, 8, 26, 15).getTime()
    expect(iso(startOfWeek(saturday, 1))).toBe('2026-09-21 00:00')
    expect(iso(startOfWeek(saturday, 0))).toBe('2026-09-20 00:00')
    expect(iso(startOfWeek(saturday, 6))).toBe('2026-09-26 00:00')
    // A Sunday with a Monday week start belongs to the week before.
    expect(iso(startOfWeek(new Date(2026, 8, 27).getTime(), 1))).toBe('2026-09-21 00:00')
  })
})

test('the month grid is six whole weeks of local midnights, DST or not', () => {
  for (const zone of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata']) {
    inZone(zone, () => {
      for (const month of [2, 9, 10]) {
        for (const firstDay of [0, 1, 6] as const) {
          const grid = monthGrid(new Date(2026, month, 15).getTime(), firstDay)
          expect(grid).toHaveLength(42)
          expect(new Date(grid[0]!).getDay()).toBe(firstDay)
          expect(grid.every((t) => new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0)).toBe(true)
          // Consecutive, and the 1st of the month is in the first week.
          expect(grid.every((t, i) => i === 0 || new Date(t).getDate() === new Date(addDays(grid[i - 1]!, 1)).getDate())).toBe(true)
          expect(grid.slice(0, 7).some((t) => new Date(t).getDate() === 1 && new Date(t).getMonth() === month)).toBe(true)
        }
      }
    })
  }
  // March 2026 starts on a Sunday: with a Sunday start there is no padding before it.
  inZone('UTC', () => expect(iso(monthGrid(new Date(2026, 2, 10).getTime(), 0)[0]!)).toBe('2026-03-01 00:00'))
})

test('months step to the same day, or the last one the month has', () => {
  inZone('UTC', () => {
    expect(iso(addMonths(new Date(2026, 0, 31).getTime(), 1))).toBe('2026-02-28 00:00')
    expect(iso(addMonths(new Date(2026, 2, 15, 10).getTime(), -3))).toBe('2025-12-15 10:00')
  })
})

test('all-day dates keep their calendar date in any zone', () => {
  for (const zone of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    inZone(zone, () => {
      const stored = Date.UTC(2026, 2, 3)
      expect(iso(allDayToLocal(stored))).toBe('2026-03-03 00:00')
      expect(localToAllDay(allDayToLocal(stored))).toBe(stored)
      expect(iso(spanOf({ key: 'a', startAt: stored, endAt: stored + DAY, allDay: true }).end)).toBe('2026-03-04 00:00')
    })
  }
})

const at = (h: number, m = 0) => Date.UTC(2026, 0, 5, h, m)
const day = Date.UTC(2026, 0, 5)
const box = (key: string, from: [number, number?], to: [number, number?]) => ({ key, start: at(...from), end: at(...to) })

test('overlapping events share the width; free columns to the right are used', () => {
  const boxes = layoutDay(
    [box('a', [9], [10]), box('b', [9, 30], [11]), box('c', [10], [10, 30]), box('d', [13], [14]), box('e', [9], [9, 30])],
    day,
    day + DAY,
  )
  const by = Object.fromEntries(boxes.map((b) => [b.key, [b.col, b.cols, b.span]]))
  // a (9–10) and e (9–9:30) start together, the longer first; b reuses e's column, c reuses a's.
  expect(by).toEqual({ a: [0, 2, 1], e: [1, 2, 1], b: [1, 2, 1], c: [0, 2, 1], d: [0, 1, 1] })
  expect(boxes.find((b) => b.key === 'b')).toMatchObject({ top: 9.5 * 60, bottom: 11 * 60 })

  // w takes y's column once y is over, and widens into z's, which is free by then.
  const wide = layoutDay([box('x', [9], [12]), box('y', [9], [10]), box('z', [9], [9, 30]), box('w', [10, 30], [11, 30])], day)
  expect(Object.fromEntries(wide.map((b) => [b.key, [b.col, b.cols, b.span]]))).toEqual({ x: [0, 3, 1], y: [1, 3, 1], z: [2, 3, 1], w: [1, 3, 2] })
})

test('touching events do not overlap, and short ones get room to be drawn', () => {
  const touching = layoutDay([box('a', [9], [10]), box('b', [10], [11])], day)
  expect(touching.map((b) => b.cols)).toEqual([1, 1])
  // Five minutes long, but drawn as 24: the next one five minutes later sits beside it.
  const short = layoutDay([box('a', [9], [9, 5]), box('b', [9, 10], [9, 40])], day)
  expect(short.map((b) => [b.key, b.col, b.cols])).toEqual([['a', 0, 2], ['b', 1, 2]])
})

test('events over midnight are clipped to each day they touch', () => {
  const late = { key: 'late', start: at(22), end: at(22) + 4 * HOUR }
  expect(layoutDay([late], day)[0]).toMatchObject({ top: 22 * 60, bottom: 24 * 60, clippedStart: false, clippedEnd: true })
  expect(layoutDay([late], day + DAY)[0]).toMatchObject({ top: 0, bottom: 2 * 60, clippedStart: true, clippedEnd: false })
  expect(layoutDay([late], day + 2 * DAY)).toEqual([])
})

test('bars across a row of days pack into lanes, longest first', () => {
  const days = Array.from({ length: 7 }, (_, i) => day + i * DAY)
  const bars = layoutRow(
    [
      { key: 'trip', start: day + DAY, end: day + 4 * DAY },
      { key: 'holiday', start: day + 2 * DAY, end: day + 3 * DAY },
      { key: 'conf', start: day - 2 * DAY, end: day + 2 * DAY },
      { key: 'late', start: day + 5 * DAY, end: day + 9 * DAY },
    ],
    days,
  )
  expect(bars.map((b) => [b.key, b.from, b.to, b.lane, b.before, b.after])).toEqual([
    ['conf', 0, 2, 0, true, false],
    ['trip', 1, 4, 1, false, false],
    ['holiday', 2, 3, 0, false, false],
    ['late', 5, 7, 0, false, true],
  ])
})

test('bars find their days on a 23-hour day', () => {
  inZone('America/New_York', () => {
    const first = new Date(2026, 2, 7).getTime()
    const days = Array.from({ length: 7 }, (_, i) => addDays(first, i))
    const monday = allDayToLocal(Date.UTC(2026, 2, 9))
    const [bar] = layoutRow([{ key: 'm', start: monday, end: addDays(monday, 1) }], days)
    expect([bar!.from, bar!.to]).toEqual([2, 3])
  })
})

test('what counts as all-day, and how a month cell overflows', () => {
  expect(isAllDayLike({ startAt: 0, endAt: DAY, allDay: true })).toBe(true)
  expect(isAllDayLike({ startAt: 0, endAt: 2 * HOUR, allDay: false })).toBe(false)
  expect(isAllDayLike({ startAt: 0, endAt: 30 * HOUR, allDay: false })).toBe(true)
  expect(monthCellFit(3, 4)).toEqual({ shown: 3, more: 0 })
  expect(monthCellFit(4, 4)).toEqual({ shown: 4, more: 0 })
  expect(monthCellFit(7, 4)).toEqual({ shown: 3, more: 4 })
  expect(MINUTE).toBe(60_000)
})

test('on a DST day events sit at their clock time in the grid', () => {
  inZone('America/New_York', () => {
    const minutes = (boxes: ReturnType<typeof layoutDay>) => Object.fromEntries(boxes.map((b) => [b.key, [b.top, b.bottom]]))
    // Fall back (Nov 1 2026, a 25-hour day) and spring forward (Mar 8 2026, 23 hours).
    for (const [y, m, d] of [[2026, 10, 1], [2026, 2, 8]] as const) {
      const start = new Date(y, m, d).getTime()
      const boxes = layoutDay(
        [
          { key: 'standup', start: new Date(y, m, d, 9).getTime(), end: new Date(y, m, d, 9, 30).getTime() },
          { key: 'late', start: new Date(y, m, d, 22).getTime(), end: new Date(y, m, d + 1, 1).getTime() },
          { key: 'overnight', start: new Date(y, m, d - 1, 23).getTime(), end: new Date(y, m, d, 0, 30).getTime() },
        ],
        start,
      )
      expect(minutes(boxes)).toEqual({ standup: [540, 570], late: [1320, 1440], overnight: [0, 30] })
    }
  })
})

describe('stableKeys', () => {
  test('an event shown once is keyed by its id, one shown twice by occurrence', () => {
    const keys = stableKeys([
      { id: 'a', key: 'a' },
      { id: 's', key: 's@1' },
      { id: 's', key: 's@2' },
      { id: 'w', key: 'w@9' },
    ])
    expect([...keys.values()]).toEqual(['a', 's@1', 's@2', 'w'])
  })
})

describe('recycleKeys', () => {
  test('the same occurrence or event keeps its key; others take what the old week left', () => {
    const prev = [
      { key: 'x', id: 'x', slot: 'k1' },
      { key: 'weekly@1', id: 'weekly', slot: 'k2' },
      { key: 'y', id: 'y', slot: 'k3' },
    ]
    const next = recycleKeys(prev, [
      { key: 'weekly@8', id: 'weekly' },
      { key: 'z', id: 'z' },
      { key: 'x', id: 'x' },
      { key: 'n', id: 'n' },
    ])
    expect(next.get('weekly@8')).toBe('k2')
    expect(next.get('x')).toBe('k1')
    expect(next.get('z')).toBe('k3')
    // More than before: a fresh key, unique among them.
    expect(new Set(next.values()).size).toBe(4)
  })
})
