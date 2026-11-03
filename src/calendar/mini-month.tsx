import { memo, useState } from 'react'
import { FONT, useSettings } from '../theme'
import { IconButton } from '../icons'
import { useCachedEvents } from '../local-data'
import { addDays, addMonths, displaySpan, monthGrid, sameDay, sameMonth, startOfDay, startOfMonth, type Weekday } from './dates'
import { dayNumber, monthYear, weekdayNarrow } from './format'

// ---------------------------------------------------------------------------
// A small month for picking a day: in the calendar's rail, and in the editor's date menus. Days with
// something on get a dot; the week or day on screen is washed so it reads as "you are here".
// ---------------------------------------------------------------------------

export const MiniMonth = memo(function MiniMonth({
  value,
  onPick,
  firstDay,
  highlight,
  dots = true,
  testId,
}: {
  /** The picked day. */
  value: number
  onPick: (day: number) => void
  firstDay: Weekday
  /** The days on screen elsewhere (the week being shown), washed behind the numbers. */
  highlight?: { from: number; to: number }
  /** Mark days that have events (reads visible calendars). */
  dots?: boolean
  testId?: string
}) {
  const { C } = useSettings()
  const [shown, setShown] = useState(() => startOfMonth(value))
  // Follow the picked day when it moves to another month from outside (Today, paging the view).
  const [lastValue, setLastValue] = useState(value)
  if (!sameDay(lastValue, value)) {
    setLastValue(value)
    if (!sameMonth(shown, value)) setShown(startOfMonth(value))
  }
  const grid = monthGrid(shown, firstDay)
  const today = startOfDay(Date.now())
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 4, userSelect: 'none' }}>
      <div style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 6 }}>
        <text style={{ flexGrow: 1, fontSize: 13, fontWeight: 600, color: C.text, fontFamily: FONT }}>{monthYear(shown)}</text>
        <IconButton icon="chevronLeft" size={14} pad={24} tooltip="Previous month" onClick={() => setShown(addMonths(shown, -1))} testId={testId ? `${testId}-prev` : undefined} />
        <IconButton icon="chevronRight" size={14} pad={24} tooltip="Next month" onClick={() => setShown(addMonths(shown, 1))} testId={testId ? `${testId}-next` : undefined} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'row' }}>
        {grid.slice(0, 7).map((day, i) => (
          <div key={i} style={{ flexGrow: 1, flexBasis: 0, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <text style={{ fontSize: 10.5, fontWeight: 600, color: C.ghost, fontFamily: FONT }}>{weekdayNarrow(day)}</text>
          </div>
        ))}
      </div>
      {dots ? <MonthDots grid={grid} /> : null}
      {[0, 1, 2, 3, 4, 5].map((week) => {
        const days = grid.slice(week * 7, week * 7 + 7)
        const washed = highlight ? days.map((d) => d >= highlight.from && d < highlight.to) : []
        return (
          <div key={week} style={{ display: 'flex', flexDirection: 'row', height: 28 }}>
            {days.map((day, i) => {
              const picked = sameDay(day, value)
              const isToday = day === today
              const outside = !sameMonth(day, shown)
              const wash = washed[i] && !picked
              return (
                // Keyed by position: another month changes the numbers in the same cells.
                <div
                  key={i}
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: wash ? C.overlay : undefined,
                    borderTopLeftRadius: wash && !washed[i - 1] ? 8 : 0,
                    borderBottomLeftRadius: wash && !washed[i - 1] ? 8 : 0,
                    borderTopRightRadius: wash && !washed[i + 1] ? 8 : 0,
                    borderBottomRightRadius: wash && !washed[i + 1] ? 8 : 0,
                  }}
                >
                  <div
                    testId={testId ? `${testId}-day-${new Date(day).getDate()}${outside ? '-out' : ''}` : undefined}
                    onClick={() => onPick(day)}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 13,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      backgroundColor: picked ? (isToday ? C.accent : C.text) : undefined,
                      hover: picked ? undefined : { backgroundColor: C.overlayStrong },
                    }}
                  >
                    <text
                      style={{
                        fontSize: 12,
                        fontWeight: isToday || picked ? 600 : 400,
                        color: picked ? (isToday ? C.onAccent : C.reading) : isToday ? C.accent : outside ? C.ghost : C.secondary,
                        fontFamily: FONT,
                        pointerEvents: 'none',
                      }}
                    >
                      {dayNumber(day)}
                    </text>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
})

/**
 * The dots under busy days: a zero-height layer before the weeks, one absolutely placed strip per
 * week (rows are 28 high with a 4 gap), whose flex cells line each dot up under its day.
 */
function MonthDots({ grid }: { grid: number[] }) {
  const { C } = useSettings()
  // The same range as the month view's, so the two share a cached answer.
  const events = useCachedEvents(grid[0]!, addDays(grid[41]!, 1))
  if (!events?.length) return null
  const busy = new Set<number>()
  for (const o of events) {
    const { start, end } = displaySpan(o)
    for (let d = startOfDay(start); d < end && busy.size < 42; d = addDays(d, 1)) busy.add(d)
  }
  return (
    <div style={{ position: 'relative', height: 0 }}>
      {[0, 1, 2, 3, 4, 5].map((week) => (
        <div key={week} style={{ position: 'absolute', top: week * 32 + 4 + 24, left: 0, right: 0, height: 3, display: 'flex', flexDirection: 'row', pointerEvents: 'none' }}>
          {grid.slice(week * 7, week * 7 + 7).map((day, i) => (
            <div key={i} style={{ flexGrow: 1, flexBasis: 0, display: 'flex', justifyContent: 'center' }}>
              {busy.has(day) ? <div style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: C.muted }} /> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
