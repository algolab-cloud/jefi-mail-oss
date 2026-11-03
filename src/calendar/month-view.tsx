import { useMemo } from 'react'
import { useWindowSize } from '@gpuix/react'
import type { Calendar, EventOccurrence } from '../engine'
import { FONT, TOPBAR_HEIGHT, useSettings } from '../theme'
import { addDays, displaySpan, sameMonth, startOfDay } from './dates'
import { dayNumber, monthShortDay, weekdayShort } from './format'
import { isAllDayLike, layoutRow, monthCellFit, spanOf, stableKeys } from './layout'
import { Anchor, DayBar, MonthLine } from './event-chip'

// ---------------------------------------------------------------------------
// The month: six weeks, multi-day events as bars across their days, timed ones as lines in their
// day, and "+N more" when a day holds more than fits. Weekends sit a shade quieter; today is ringed.
// ---------------------------------------------------------------------------

const HEADER = 30
const LINE = 22
const DAY_LABEL = 30

export function MonthView({
  grid,
  cursor,
  occurrences,
  calendars,
  now,
  weekend,
  selected,
  onSelect,
  renderCard,
  onCreate,
  onPickDay,
}: {
  grid: number[]
  cursor: number
  occurrences: EventOccurrence[]
  calendars: Map<string, Calendar>
  now: number
  weekend: number[]
  selected: string | null
  onSelect: (key: string | null) => void
  renderCard: (occurrence: EventOccurrence, side: 'left' | 'right') => React.ReactNode
  onCreate: (range: { start: number; end: number; allDay: boolean }) => void
  onPickDay: (day: number) => void
}) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const { height } = useWindowSize()
  const today = startOfDay(now)
  // Six rows share the height under the toolbar and weekday header.
  const rowHeight = Math.max(80, (height - TOPBAR_HEIGHT - HEADER - 2) / 6)
  const capacity = Math.max(1, Math.floor((rowHeight - DAY_LABEL - 4) / LINE))
  const byKey = useMemo(() => new Map(occurrences.map((o) => [o.key, o])), [occurrences])

  const weeks = useMemo(
    () =>
      [0, 1, 2, 3, 4, 5].map((w) => {
        const days = grid.slice(w * 7, w * 7 + 7)
        const end = addDays(days[6]!, 1)
        const inWeek = occurrences.filter((o) => {
          const s = displaySpan(o)
          return s.end > days[0]! && s.start < end
        })
        const bars = layoutRow(inWeek.filter(isAllDayLike).map(spanOf), days)
        const timed = days.map((day) => {
          const next = addDays(day, 1)
          return inWeek.filter((o) => !isAllDayLike(o) && o.startAt < next && Math.max(o.endAt, o.startAt + 1) > day)
        })
        return { days, bars, timed }
      }),
    [grid, occurrences],
  )

  return (
    // Clicking about the month (double-clicking a day makes an event) shouldn't select its text.
    <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', userSelect: 'none' }}>
      <div style={{ height: HEADER, flexShrink: 0, display: 'flex', flexDirection: 'row', borderBottomWidth: 1, borderColor: C.divider }}>
        {grid.slice(0, 7).map((day, i) => (
          <div key={i} style={{ flexGrow: 1, flexBasis: 0, display: 'flex', alignItems: 'center', paddingLeft: 10 }}>
            <text style={{ fontSize: 11.5, fontWeight: 600, color: weekend.includes(new Date(day).getDay()) ? C.ghost : C.muted, fontFamily: FONT }}>{weekdayShort(day)}</text>
          </div>
        ))}
      </div>
      {weeks.map(({ days, bars, timed }, w) => {
        // Bar lanes come first in every cell of the week; lines fill what's left of each day.
        const barLanes = Math.min(capacity, bars.reduce((n, b) => Math.max(n, b.lane + 1), 0))
        const barIds = stableKeys(bars.map((b) => byKey.get(b.key)!))
        return (
          // Weeks and days keyed by position: paging a month changes what's in the same cells.
          <div key={w} style={{ flexGrow: 1, flexBasis: 0, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'row', borderBottomWidth: w < 5 ? 1 : 0, borderColor: C.divider, overflow: 'hidden' }}>
            {days.map((day, i) => {
              const isToday = day === today
              const outside = !sameMonth(day, cursor)
              const hiddenBars = bars.filter((b) => b.from <= i && b.to > i && b.lane >= barLanes).length
              const lines = timed[i]!
              const room = Math.max(0, capacity - barLanes)
              const fit = monthCellFit(lines.length + hiddenBars, room)
              const shownLines = lines.slice(0, Math.min(lines.length, fit.shown))
              const first = new Date(day).getDate() === 1
              return (
                <div
                  key={i}
                  testId={`month-cell-${new Date(day).getMonth() + 1}-${new Date(day).getDate()}`}
                  onClick={(event) => {
                    if (selected) return onSelect(null)
                    if (event.clickCount === 2) onCreate({ start: day, end: addDays(day, 1), allDay: true })
                  }}
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    borderLeftWidth: i ? 1 : 0,
                    borderColor: C.divider,
                    backgroundColor: outside ? (dark ? '#00000026' : '#00000006') : weekend.includes(new Date(day).getDay()) ? (dark ? '#FFFFFF04' : '#00000003') : '#00000001',
                  }}
                >
                  <div style={{ height: DAY_LABEL, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 6, paddingRight: 6 }}>
                    <div
                      testId={`month-day-${new Date(day).getMonth() + 1}-${new Date(day).getDate()}`}
                      onClick={() => onPickDay(day)}
                      style={{
                        minWidth: 24,
                        height: 24,
                        paddingLeft: first && !isToday ? 6 : 0,
                        paddingRight: first && !isToday ? 6 : 0,
                        borderRadius: 12,
                        backgroundColor: isToday ? C.accent : undefined,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        hover: isToday ? { backgroundColor: C.accentHover } : { backgroundColor: C.overlayStrong },
                      }}
                    >
                      <text style={{ fontSize: 12.5, fontWeight: isToday || first ? 600 : 500, color: isToday ? C.onAccent : outside ? C.ghost : C.secondary, fontFamily: FONT, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                        {first && !isToday ? monthShortDay(day) : dayNumber(day)}
                      </text>
                    </div>
                  </div>
                  <div style={{ height: barLanes * LINE, flexShrink: 0 }} />
                  <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 4, paddingRight: 4, gap: 2 }}>
                    {/* By position: another month fills the same lines with its events. */}
                    {shownLines.map((o, n) => (
                      <Anchor key={n} card={selected === o.key ? renderCard(o, i >= 4 ? 'left' : 'right') : null}>
                        <MonthLine
                          occurrence={o}
                          calendar={calendars.get(o.calendarId)}
                          past={o.endAt <= now}
                          selected={selected === o.key}
                          onClick={() => onSelect(selected === o.key ? null : o.key)}
                          testId={`event-${o.title}`}
                        />
                      </Anchor>
                    ))}
                    {fit.more ? (
                      <div
                        testId={`month-more-${new Date(day).getDate()}`}
                        onClick={() => onPickDay(day)}
                        style={{ height: 18, paddingLeft: 6, borderRadius: 5, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
                      >
                        <text style={{ fontSize: 11, fontWeight: 600, color: C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{`+${fit.more} more`}</text>
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
            {bars
              .filter((b) => b.lane < barLanes)
              .map((bar) => {
                const o = byKey.get(bar.key)!
                return (
                  <div key={barIds.get(bar.key)} style={{ position: 'absolute', top: DAY_LABEL + bar.lane * LINE, left: 0, right: 0, height: LINE - 2, display: 'flex', flexDirection: 'row', pointerEvents: 'none' }}>
                    <div style={{ flexGrow: bar.from, flexBasis: 0 }} />
                    <div style={{ flexGrow: bar.to - bar.from, flexBasis: 0, minWidth: 0, paddingLeft: bar.before ? 0 : 4, paddingRight: bar.after ? 0 : 4, pointerEvents: 'auto' }}>
                      <Anchor card={selected === o.key ? renderCard(o, bar.from >= 4 ? 'left' : 'right') : null}>
                        <DayBar
                          occurrence={o}
                          calendar={calendars.get(o.calendarId)}
                          past={displaySpan(o).end <= today}
                          selected={selected === o.key}
                          before={bar.before}
                          after={bar.after}
                          onClick={() => onSelect(selected === o.key ? null : o.key)}
                          testId={`event-${o.title}`}
                        />
                      </Anchor>
                    </div>
                    <div style={{ flexGrow: 7 - bar.to, flexBasis: 0 }} />
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}
