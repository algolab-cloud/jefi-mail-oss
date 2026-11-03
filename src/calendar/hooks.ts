import { useEffect, useMemo, useState } from 'react'
import type { Calendar } from '../engine'
import { useCalendars } from '../local-data'
import { firstDayOfWeek, weekendDays, type Weekday } from './dates'

/** The time, refreshed on the minute (for the now line and dimming what's past). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(Date.now())
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    }
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    return () => clearTimeout(timer)
  }, [])
  return now
}

/** Calendars by id, for colouring occurrences. */
export function useCalendarMap(): Map<string, Calendar> {
  const calendars = useCalendars()
  return useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars])
}

// The locale doesn't change while Jefi runs.
let week: { firstDay: Weekday; weekend: Weekday[] } | null = null
export function useWeekInfo() {
  week ??= { firstDay: firstDayOfWeek(), weekend: weekendDays() }
  return week
}
