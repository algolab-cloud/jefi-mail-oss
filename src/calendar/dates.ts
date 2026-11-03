// ---------------------------------------------------------------------------
// Calendar dates on the UI side. Everything here works in the person's own zone (the runtime's
// local time), stepping days with Date's local setters so a DST change makes a 23- or 25-hour day
// rather than a day that starts at 01:00. All-day events are stored as UTC midnights (see
// docs/calendar-notes-architecture.md); `allDayToLocal` / `localToAllDay` convert at the edge.
// ---------------------------------------------------------------------------

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** 0 = Sunday … 6 = Saturday, like Date#getDay. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export function startOfDay(t: number): number {
  return new Date(t).setHours(0, 0, 0, 0)
}

/** The same wall-clock time `n` days later (a DST change doesn't shift it by an hour). */
export function addDays(t: number, n: number): number {
  const d = new Date(t)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

export function startOfWeek(t: number, firstDay: Weekday): number {
  const day = startOfDay(t)
  return addDays(day, -((new Date(day).getDay() - firstDay + 7) % 7))
}

export function startOfMonth(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** Months later, on the same day where that month has it and its last day otherwise. */
export function addMonths(t: number, n: number): number {
  const d = new Date(t)
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(d.getDate(), last))
  target.setHours(d.getHours(), d.getMinutes(), 0, 0)
  return target.getTime()
}

/** The local midnights of the 6 × 7 days a month view shows: the month, padded to whole weeks. */
export function monthGrid(t: number, firstDay: Weekday): number[] {
  const first = startOfWeek(startOfMonth(t), firstDay)
  return Array.from({ length: 42 }, (_, i) => addDays(first, i))
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b)
export const sameMonth = (a: number, b: number) => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
}

/** Minutes since local midnight (wall clock, so 09:00 is 540 on a DST day too). */
export const minutesOfDay = (t: number) => {
  const d = new Date(t)
  return d.getHours() * 60 + d.getMinutes()
}

/** The instant a wall-clock time on a day falls on. */
export const atMinutes = (day: number, minutes: number) => new Date(day).setHours(0, minutes, 0, 0)

/** An all-day date (its UTC midnight) as the local midnight of the same calendar date. */
export function allDayToLocal(utcMidnight: number): number {
  const d = new Date(utcMidnight)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime()
}

/** A local day as the UTC midnight the engine stores all-day dates as. */
export function localToAllDay(local: number): number {
  const d = new Date(local)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Where an occurrence sits on the person's clock: all-day dates become local midnights (end exclusive). */
export function displaySpan(o: { startAt: number; endAt: number; allDay: boolean }): { start: number; end: number } {
  if (!o.allDay) return { start: o.startAt, end: Math.max(o.endAt, o.startAt) }
  const start = allDayToLocal(o.startAt)
  return { start, end: Math.max(allDayToLocal(o.endAt), addDays(start, 1)) }
}

// --- Locale ------------------------------------------------------------------

/** Regions whose weeks start on Sunday or Saturday, for runtimes without Intl.Locale week info. */
const SUNDAY_REGIONS = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'IN', 'PH', 'ZA', 'AU', 'SA', 'PE', 'CO', 'VE', 'AR', 'GT', 'TH', 'ID', 'KE', 'PK'])
const SATURDAY_REGIONS = new Set(['AE', 'AF', 'BH', 'DJ', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY'])

/** The locale's first day of the week (Monday unless the locale says otherwise). */
export function firstDayOfWeek(locale?: string): Weekday {
  try {
    const loc = new Intl.Locale(locale ?? Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const info = loc.getWeekInfo?.() ?? loc.weekInfo
    if (info?.firstDay) return (info.firstDay % 7) as Weekday
    const region = loc.maximize().region ?? ''
    return SUNDAY_REGIONS.has(region) ? 0 : SATURDAY_REGIONS.has(region) ? 6 : 1
  } catch {
    return 1
  }
}

/** Weekend days for the locale (Saturday and Sunday unless it says otherwise). */
export function weekendDays(locale?: string): Weekday[] {
  try {
    const loc = new Intl.Locale(locale ?? Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      getWeekInfo?: () => { weekend: number[] }
      weekInfo?: { weekend: number[] }
    }
    const weekend = (loc.getWeekInfo?.() ?? loc.weekInfo)?.weekend
    if (weekend?.length) return weekend.map((d) => (d % 7) as Weekday)
  } catch {}
  return [6, 0]
}
