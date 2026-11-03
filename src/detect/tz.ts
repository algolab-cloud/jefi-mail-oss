// Wall-clock <-> epoch conversion for IANA zones using only Intl, so both
// date detection and .ics parsing stay correct across DST transitions.

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string) {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string) {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

export type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number }

// Wall-clock fields of an instant in a zone (month is 1-based).
export function wallTime(epoch: number, timeZone: string): Wall {
  const parts: Record<string, number> = {}
  for (const p of formatter(timeZone).formatToParts(new Date(epoch))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  }
}

// Offset of the zone from UTC at an instant, in minutes (east positive).
export function offsetMinutes(epoch: number, timeZone: string) {
  const w = wallTime(epoch, timeZone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return Math.round((asUtc - Math.floor(epoch / 1000) * 1000) / 60000)
}

// Epoch ms for a wall-clock time in a zone. Times in a spring-forward gap
// resolve forward (02:30 -> 03:30); ambiguous fall-back times pick the
// earlier (daylight) instant, as RFC 5545 asks.
export function zonedToEpoch(w: Wall, timeZone: string) {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  const before = offsetMinutes(asUtc - 36e5 * 14, timeZone)
  const after = offsetMinutes(asUtc + 36e5 * 14, timeZone)
  const a = asUtc - before * 60000
  const b = asUtc - after * 60000
  const okA = offsetMinutes(a, timeZone) === before
  const okB = offsetMinutes(b, timeZone) === after
  if (okA && okB) return Math.min(a, b)
  if (okA) return a
  if (okB) return b
  // Gap: the wall time never happens, so keep the pre-transition offset,
  // which lands it after the jump.
  return a
}
