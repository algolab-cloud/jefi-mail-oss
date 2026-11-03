import { DAY, MINUTE, addDays, displaySpan } from './dates'

// ---------------------------------------------------------------------------
// Where events go on screen. Pure: occurrences and days in, positions out, so the geometry can be
// tested without drawing anything.
// ---------------------------------------------------------------------------

export type Span = { key: string; start: number; end: number }

/** An event within one day of a time grid: minutes from midnight, and its share of the width. */
export type TimedBox = {
  key: string
  /** Minutes since the day's start, clipped to the day. */
  top: number
  bottom: number
  /** Its column among the events it overlaps, of `cols`; `span` columns wide (free ones to its right). */
  col: number
  cols: number
  span: number
  /** It began the day before, or goes on past midnight. */
  clippedStart: boolean
  clippedEnd: boolean
}

/** Minutes from `dayStart` to `t` on the wall clock: elapsed time, less any DST change between them. */
export const clockMinutes = (t: number, dayStart: number) => (t - dayStart) / MINUTE - (new Date(t).getTimezoneOffset() - new Date(dayStart).getTimezoneOffset())

/** Short events still take this much room when deciding what overlaps, since they're drawn this tall. */
export const MIN_BOX_MINUTES = 24

/**
 * Lays out one day's timed events the way calendars do: events that overlap share the width in
 * columns, each placed in the leftmost column free at its start, and one widens into free columns
 * to its right. A group ("cluster") of transitively overlapping events shares one column count.
 */
export function layoutDay(spans: Span[], dayStart: number, dayEnd = addDays(dayStart, 1)): TimedBox[] {
  // Positions are wall-clock minutes, as the grid's hour labels are: on a DST day the elapsed time
  // since midnight is an hour off the clock after the change, which put a 9:00 meeting at 10:00.
  const wall = (t: number) => clockMinutes(t, dayStart)
  const length = wall(dayEnd)
  const items = spans
    .filter((s) => s.end > dayStart && s.start < dayEnd)
    .map((s) => {
      const top = Math.max(0, Math.min(length, wall(s.start)))
      const bottom = Math.max(top, Math.min(length, wall(s.end)))
      return { key: s.key, top, bottom, visualBottom: Math.max(bottom, Math.min(length, top + MIN_BOX_MINUTES)), clippedStart: s.start < dayStart, clippedEnd: s.end > dayEnd }
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || (a.key < b.key ? -1 : 1))

  const out: TimedBox[] = []
  let cluster: Array<(typeof items)[number] & { col: number }> = []
  let columnsEnd: number[] = []
  let clusterEnd = -1
  const flush = () => {
    const cols = columnsEnd.length
    for (const item of cluster) {
      // Widen into the columns to the right that nothing in the cluster uses while this is on.
      let span = 1
      while (item.col + span < cols && !cluster.some((o) => o.col === item.col + span && o.top < item.visualBottom && o.visualBottom > item.top)) span++
      out.push({ key: item.key, top: item.top, bottom: item.bottom, col: item.col, cols, span, clippedStart: item.clippedStart, clippedEnd: item.clippedEnd })
    }
    cluster = []
    columnsEnd = []
  }
  for (const item of items) {
    if (item.top >= clusterEnd) {
      flush()
      clusterEnd = -1
    }
    let col = columnsEnd.findIndex((end) => end <= item.top)
    if (col === -1) col = columnsEnd.push(item.visualBottom) - 1
    else columnsEnd[col] = item.visualBottom
    cluster.push({ ...item, col })
    clusterEnd = Math.max(clusterEnd, item.visualBottom)
  }
  flush()
  return out
}

/** An event across a row of days (the all-day row, a month week): which days, and which lane. */
export type RowBar = {
  key: string
  /** Index of the first day it covers in the row, and one past the last. */
  from: number
  to: number
  lane: number
  /** It started before the row, or ends after it. */
  before: boolean
  after: boolean
}

/**
 * Packs events that cover whole days into lanes across a row of consecutive days (local
 * midnights): longer ones first so they sit on top, each in the first lane free for all its days.
 */
export function layoutRow(spans: Span[], days: number[]): RowBar[] {
  if (!days.length) return []
  const rowStart = days[0]!
  const rowEnd = addDays(days[days.length - 1]!, 1)
  const indexOf = (t: number) => {
    // Days can be 23 or 25 hours, so find the day rather than dividing.
    let i = days.length - 1
    while (i > 0 && days[i]! > t) i--
    return i
  }
  const bars = spans
    .filter((s) => s.end > rowStart && s.start < rowEnd)
    .map((s) => {
      const from = indexOf(Math.max(s.start, rowStart))
      const to = indexOf(Math.min(s.end, rowEnd) - 1) + 1
      return { key: s.key, from, to, before: s.start < rowStart, after: s.end > rowEnd, length: s.end - s.start, start: s.start }
    })
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || b.length - a.length || a.start - b.start || (a.key < b.key ? -1 : 1))
  const lanes: boolean[][] = []
  return bars.map(({ key, from, to, before, after }) => {
    let lane = lanes.findIndex((used) => used.slice(from, to).every((u) => !u))
    if (lane === -1) lane = lanes.push(Array(days.length).fill(false)) - 1
    for (let i = from; i < to; i++) lanes[lane]![i] = true
    return { key, from, to, lane, before, after }
  })
}

/**
 * Whether an occurrence belongs in the all-day row (or spans a month week as a bar) rather than on
 * the time grid: all-day events, and timed ones that run a full day or more.
 */
export function isAllDayLike(o: { startAt: number; endAt: number; allDay: boolean }): boolean {
  return o.allDay || o.endAt - o.startAt >= DAY
}

export const spanOf = (o: { key: string; startAt: number; endAt: number; allDay: boolean }): Span => ({ key: o.key, ...displaySpan(o) })

/** How many items fit in a month cell, keeping a line for "+N more" when some don't. */
export function monthCellFit(total: number, capacity: number): { shown: number; more: number } {
  if (total <= capacity) return { shown: total, more: 0 }
  const shown = Math.max(0, capacity - 1)
  return { shown, more: total - shown }
}

/**
 * React keys for occurrences: the event's id where it's there once, so an event that repeats weekly
 * keeps its element when the week changes; the occurrence key where one event shows twice.
 */
export function stableKeys(occurrences: Array<{ id: string; key: string }>): Map<string, string> {
  const count = new Map<string, number>()
  for (const o of occurrences) count.set(o.id, (count.get(o.id) ?? 0) + 1)
  return new Map(occurrences.map((o) => [o.key, count.get(o.id) === 1 ? o.id : o.key]))
}

let nextSlot = 0

/**
 * React keys for a column's occurrences that reuse the previous ones: the same occurrence, or the
 * same event (a weekly one on the next week), keeps its key; anything else takes a key left over
 * from what's gone, so paging to another week updates the elements already there (new text, a new
 * top) rather than destroying them all and building new ones. Fresh keys only when there are more.
 */
export function recycleKeys(prev: Array<{ key: string; id: string; slot: string }>, next: Array<{ key: string; id: string }>): Map<string, string> {
  const byKey = new Map(prev.map((p) => [p.key, p.slot]))
  const idCount = new Map<string, number>()
  for (const p of prev) idCount.set(p.id, (idCount.get(p.id) ?? 0) + 1)
  const byId = new Map(prev.filter((p) => idCount.get(p.id) === 1).map((p) => [p.id, p.slot]))
  const taken = new Set<string>()
  const out = new Map<string, string>()
  for (const o of next) {
    const slot = byKey.get(o.key) ?? byId.get(o.id)
    if (slot !== undefined && !taken.has(slot)) {
      taken.add(slot)
      out.set(o.key, slot)
    }
  }
  const free = prev.map((p) => p.slot).filter((slot) => !taken.has(slot))
  for (const o of next) if (!out.has(o.key)) out.set(o.key, free.shift() ?? `slot-${++nextSlot}`)
  return out
}
