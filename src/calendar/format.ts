import { mixHex, type Colors } from '../theme'
import { addDays, displaySpan, sameDay, sameMonth, startOfWeek, type Weekday } from './dates'
import type { CalendarView } from './state'

// ---------------------------------------------------------------------------
// Words and colours for the calendar: dates through Intl in the person's locale and zone, and the
// tints an event takes from its calendar's colour in either theme.
// ---------------------------------------------------------------------------

const cache = new Map<string, Intl.DateTimeFormat>()
const fmt = (options: Intl.DateTimeFormatOptions) => {
  const key = JSON.stringify(options)
  let f = cache.get(key)
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat(undefined, options)))
  return f
}

/** Whether the locale writes times on a 12-hour clock. */
export const uses12Hour = () => fmt({ hour: 'numeric' }).resolvedOptions().hour12 === true

/** "9:30 AM" / "09:30"; "9 AM" on the hour when `compact`. */
export function timeText(t: number, compact = false): string {
  const d = new Date(t)
  if (compact && d.getMinutes() === 0) return fmt({ hour: 'numeric' }).format(d)
  return fmt({ hour: 'numeric', minute: '2-digit' }).format(d)
}

/** The hour labels down a time grid's gutter. */
export const hourText = (hour: number) => fmt({ hour: 'numeric' }).format(new Date(2026, 0, 5, hour))

export const weekdayShort = (t: number) => fmt({ weekday: 'short' }).format(new Date(t))
export const weekdayNarrow = (t: number) => fmt({ weekday: 'narrow' }).format(new Date(t))
export const weekdayLong = (t: number) => fmt({ weekday: 'long' }).format(new Date(t))
export const dayNumber = (t: number) => fmt({ day: 'numeric' }).format(new Date(t))
export const monthYear = (t: number) => fmt({ month: 'long', year: 'numeric' }).format(new Date(t))
export const monthShort = (t: number) => fmt({ month: 'short' }).format(new Date(t))
export const monthShortDay = (t: number) => fmt({ month: 'short', day: 'numeric' }).format(new Date(t))
export const fullDate = (t: number) => fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(t))
export const mediumDate = (t: number) => fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(t))

/** The toolbar's title for what's on screen. */
export function rangeTitle(view: CalendarView, cursor: number, firstDay: Weekday): string {
  if (view === 'month') return monthYear(cursor)
  if (view === 'day') return fullDate(cursor)
  if (view === 'agenda') return `From ${monthShortDay(cursor)}`
  const start = startOfWeek(cursor, firstDay)
  const end = addDays(start, 6)
  return fmt({ month: 'short', day: 'numeric', year: 'numeric' }).formatRange(new Date(start), new Date(end))
}

/** When an occurrence happens, in words: "9:00 – 10:30 AM", "All day", "Mar 3 – 5". */
export function whenText(o: { startAt: number; endAt: number; allDay: boolean }): string {
  const { start, end } = displaySpan(o)
  if (o.allDay) {
    const last = addDays(end, -1)
    return sameDay(start, last) ? 'All day' : fmt({ month: 'short', day: 'numeric' }).formatRange(new Date(start), new Date(last))
  }
  if (sameDay(start, end) || end === addDays(new Date(start).setHours(0, 0, 0, 0), 1)) return fmt({ hour: 'numeric', minute: '2-digit' }).formatRange(new Date(start), new Date(end))
  return fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).formatRange(new Date(start), new Date(end))
}

/** The detail card's date line: "Saturday, September 26" plus the year when it isn't this one's. */
export function dayLine(t: number, now = Date.now()): string {
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear()
  return fmt(sameYear ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(t))
}

export { sameMonth }

// --- Colour ---------------------------------------------------------------------

/** The swatches a calendar can take, readable on both themes. */
export const CALENDAR_COLORS = ['#3E63DD', '#E5484D', '#12A594', '#F76B15', '#8E4EC6', '#D6409F', '#46A758', '#FFB224', '#0090FF', '#6E6E77']

const HEX = /^#[0-9a-f]{6}$/i

/** A colour mixHex can work with; anything else falls back to the accent. */
export const solid = (color: string, C: Colors) => (HEX.test(color) ? color.toUpperCase() : C.accent)

/**
 * An event's surface in a calendar's colour: a soft fill of it over the page, a strong edge, and
 * text that stays readable on either theme.
 */
export function eventTint(color: string, C: Colors, dark: boolean, opts: { past?: boolean; hover?: boolean } = {}) {
  const base = solid(color, C)
  const page = solid(C.reading, C)
  const fill = mixHex(base, page, dark ? (opts.hover ? 0.7 : 0.76) : opts.hover ? 0.78 : 0.85)
  return {
    fill: opts.past ? mixHex(fill, page, 0.45) : fill,
    edge: opts.past ? mixHex(base, page, 0.45) : base,
    text: opts.past ? (dark ? mixHex(mixHex(base, '#FFFFFF', 0.6), page, 0.35) : mixHex(mixHex(base, '#000000', 0.55), page, 0.35)) : dark ? mixHex(base, '#FFFFFF', 0.72) : mixHex(base, '#000000', 0.62),
    sub: opts.past ? (dark ? mixHex(mixHex(base, '#FFFFFF', 0.5), page, 0.5) : mixHex(mixHex(base, '#000000', 0.35), page, 0.5)) : dark ? mixHex(base, '#FFFFFF', 0.45) : mixHex(base, '#000000', 0.35),
  }
}
