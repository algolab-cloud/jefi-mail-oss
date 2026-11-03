// ---------------------------------------------------------------------------
// A small RRULE expander for recurring events: FREQ DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
// COUNT, UNTIL, WKST and (weekly only) BYDAY. Anything else is rejected when an event is saved
// rather than half-expanded. Occurrences keep the master's wall-clock time in its IANA zone, which is what
// makes a 9:00 weekly meeting stay at 9:00 across a DST change; all-day events recur in UTC dates.
// ---------------------------------------------------------------------------

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export type RRule = {
  freq: Freq
  interval: number
  count?: number
  /** Raw UNTIL value: YYYYMMDD, YYYYMMDDTHHMMSS (the event's zone) or YYYYMMDDTHHMMSSZ. */
  until?: string
  /** Weekdays, 0 = Sunday. */
  byDay?: number[]
  /** Week start, 0 = Sunday; RFC 5545's default is Monday. */
  wkst: number
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DAY_MS = 86_400_000
/** Candidates tried per expansion: enough for 270 years of daily events, and a bound on bad input. */
const MAX_STEPS = 100_000

/** Parses an RRULE (with or without the `RRULE:` prefix); throws on anything the expander can't honour. */
export function parseRRule(text: string): RRule {
  const body = text.trim().replace(/^RRULE:/i, '')
  const parts = new Map<string, string>()
  for (const part of body.split(';')) {
    if (!part) continue
    const [key, value] = part.split('=')
    if (!key || value === undefined) throw new Error(`Unsupported recurrence: ${text}`)
    parts.set(key.toUpperCase(), value.toUpperCase())
  }
  const freq = parts.get('FREQ') as Freq | undefined
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw new Error(`Unsupported recurrence frequency: ${parts.get('FREQ') ?? 'none'}`)
  const rule: RRule = { freq, interval: 1, wkst: 1 }
  for (const [key, value] of parts) {
    if (key === 'FREQ') continue
    else if (key === 'INTERVAL') rule.interval = positive(value, key)
    else if (key === 'COUNT') rule.count = positive(value, key)
    else if (key === 'UNTIL') {
      if (!/^\d{8}(T\d{6}Z?)?$/.test(value)) throw new Error(`Unsupported UNTIL: ${value}`)
      rule.until = value
    } else if (key === 'WKST') rule.wkst = day(value)
    else if (key === 'BYDAY' && freq === 'WEEKLY') rule.byDay = [...new Set(value.split(',').map(day))]
    else throw new Error(`Unsupported recurrence part: ${key}`)
  }
  if (rule.count !== undefined && rule.until !== undefined) throw new Error('A recurrence has COUNT or UNTIL, not both')
  return rule
}

const positive = (value: string, key: string) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`Unsupported ${key}: ${value}`)
  return n
}
const day = (code: string) => {
  const index = DAYS.indexOf(code)
  if (index < 0) throw new Error(`Unsupported weekday: ${code}`)
  return index
}

export function formatRRule(rule: RRule): string {
  return [
    `FREQ=${rule.freq}`,
    ...(rule.interval !== 1 ? [`INTERVAL=${rule.interval}`] : []),
    ...(rule.byDay?.length ? [`BYDAY=${rule.byDay.map((d) => DAYS[d]).join(',')}`] : []),
    ...(rule.wkst !== 1 ? [`WKST=${DAYS[rule.wkst]}`] : []),
    ...(rule.count !== undefined ? [`COUNT=${rule.count}`] : []),
    ...(rule.until !== undefined ? [`UNTIL=${rule.until}`] : []),
  ].join(';')
}

// --- Wall clock in an IANA zone ----------------------------------------------

type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
const formatter = (zone: string) => {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(zone, f)
  }
  return f
}

/** Throws for a zone Intl doesn't know, so a bad zone fails the save instead of every listing. */
export function checkTimeZone(zone: string) {
  formatter(zone)
}

export function wallOf(t: number, zone: string): Wall {
  if (zone === 'UTC') {
    const d = new Date(t)
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
  }
  const parts: Record<string, number> = {}
  for (const p of formatter(zone).formatToParts(new Date(t))) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour!, mi: parts.minute!, s: parts.second! }
}

const utcOf = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s)
const offsetAt = (t: number, zone: string) => utcOf(wallOf(t, zone)) - Math.floor(t / 1000) * 1000

/**
 * The instant a wall-clock time names in `zone`. A time the spring-forward gap skips moves forward
 * by the gap (02:30 → 03:30); a time the fall-back repeats is its first instance (RFC 5545 3.3.5).
 */
export function epochOf(w: Wall, zone: string): number {
  const guess = utcOf(w)
  if (zone === 'UTC') return guess
  // The offsets in force within a day either side cover both sides of any change near this time.
  const offsets = [...new Set([offsetAt(guess - DAY_MS, zone), offsetAt(guess, zone), offsetAt(guess + DAY_MS, zone)])]
  const named = offsets.map((o) => guess - o).filter((t) => utcOf(wallOf(t, zone)) === guess)
  if (named.length) return Math.min(...named)
  // In the gap no instant names it: read it with the offset from before the change.
  return guess - offsetAt(guess - DAY_MS, zone)
}

// --- Expansion ----------------------------------------------------------------

export type RecurringSeries = {
  startAt: number
  endAt: number
  allDay: boolean
  timeZone: string | null
  recurrence: string
  /** Occurrence starts removed from the series (deleted, or replaced by an exception event). */
  exdates?: number[]
}

export type Occurrence = { start: number; end: number }

const addDays = (y: number, m: number, d: number, n: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** Latest occurrence start the rule allows, or null when it has no UNTIL. */
function untilOf(rule: RRule, zone: string, allDay: boolean): number | null {
  if (!rule.until) return null
  const u = rule.until
  const y = Number(u.slice(0, 4))
  const m = Number(u.slice(4, 6))
  const d = Number(u.slice(6, 8))
  if (u.length === 8) return allDay ? Date.UTC(y, m - 1, d) : epochOf({ y, m, d, h: 23, mi: 59, s: 59 }, zone)
  const wall = { y, m, d, h: Number(u.slice(9, 11)), mi: Number(u.slice(11, 13)), s: Number(u.slice(13, 15)) }
  return u.endsWith('Z') ? utcOf(wall) : epochOf(wall, zone)
}

/** Dates (in the series' zone) the rule could fall on, in order, starting from the first one's week/month. */
function* candidates(rule: RRule, start: Wall): Generator<{ y: number; m: number; d: number }> {
  const { interval } = rule
  if (rule.freq === 'DAILY') {
    for (let i = 0; ; i++) yield addDays(start.y, start.m, start.d, i * interval)
  }
  if (rule.freq === 'WEEKLY') {
    const dow = new Date(Date.UTC(start.y, start.m - 1, start.d)).getUTCDay()
    const days = (rule.byDay?.length ? rule.byDay : [dow]).map((d) => (d - rule.wkst + 7) % 7).sort((a, b) => a - b)
    const weekStart = addDays(start.y, start.m, start.d, -((dow - rule.wkst + 7) % 7))
    for (let w = 0; ; w++) for (const offset of days) yield addDays(weekStart.y, weekStart.m, weekStart.d, w * 7 * interval + offset)
  }
  if (rule.freq === 'MONTHLY') {
    for (let k = 0; ; k++) {
      const index = start.m - 1 + k * interval
      const y = start.y + Math.floor(index / 12)
      const m = (index % 12) + 1
      // A month without that day (the 31st in April) has no occurrence, as RFC 5545 says.
      if (start.d <= daysIn(y, m)) yield { y, m, d: start.d }
      else yield { y, m, d: 0 }
    }
  }
  for (let k = 0; ; k++) {
    const y = start.y + k * interval
    yield start.d <= daysIn(y, start.m) ? { y, m: start.m, d: start.d } : { y, m: start.m, d: 0 }
  }
}

/**
 * Occurrences of a series overlapping [from, to), in order. An occurrence overlaps when it ends
 * after `from` (or, for a zero-length one, starts at or after it) and starts before `to`. COUNT
 * counts every occurrence the rule makes, including those EXDATE later removes.
 */
export function expandSeries(series: RecurringSeries, from: number, to: number): Occurrence[] {
  const rule = parseRRule(series.recurrence)
  const zone = series.allDay ? 'UTC' : series.timeZone || 'UTC'
  const start = wallOf(series.startAt, zone)
  const duration = Math.max(0, series.endAt - series.startAt)
  const until = untilOf(rule, zone, series.allDay)
  const skip = new Set(series.exdates ?? [])
  const out: Occurrence[] = []
  let made = 0
  let steps = 0
  for (const date of candidates(rule, start)) {
    if (++steps > MAX_STEPS) break
    if (date.d === 0) continue
    const t = epochOf({ ...date, h: start.h, mi: start.mi, s: start.s }, zone)
    if (t < series.startAt) continue
    if (rule.count !== undefined && ++made > rule.count) break
    if (until !== null && t > until) break
    if (t >= to) break
    if (skip.has(t)) continue
    const end = t + duration
    if (end > from || t >= from) out.push({ start: t, end })
  }
  return out
}

/** When the series' last occurrence ends, or null if it never stops (or runs past the step bound). */
export function seriesEnd(series: RecurringSeries): number | null {
  const rule = parseRRule(series.recurrence)
  if (rule.count === undefined && rule.until === undefined) return null
  const all = expandSeries({ ...series, exdates: [] }, -Infinity, Infinity)
  if (rule.count !== undefined && all.length < rule.count) return null
  return all.at(-1)?.end ?? series.endAt
}

/** The rule, ended just before the occurrence at `occurrenceStart` (for "this and following"). */
export function endBefore(recurrence: string, occurrenceStart: number, allDay: boolean): string {
  const rule = parseRRule(recurrence)
  delete rule.count
  const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  rule.until = allDay ? stamp(occurrenceStart - DAY_MS).slice(0, 8) : stamp(occurrenceStart - 1000)
  return formatRRule(rule)
}

/** How many occurrences a rule makes before `occurrenceStart`, for splitting a COUNT series. */
export function occurrencesBefore(series: RecurringSeries, occurrenceStart: number): number {
  return expandSeries({ ...series, exdates: [] }, -Infinity, occurrenceStart).length
}
