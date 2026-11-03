import { useMemo, useState } from 'react'
import type { Calendar, EventOccurrence } from '../engine'
import { FONT, useSettings } from '../theme'
import { Icon } from '../icons'
import { addDays, displaySpan, startOfDay } from './dates'
import { dayNumber, monthShort, solid, timeText, weekdayShort } from './format'
import { Anchor } from './event-chip'

// ---------------------------------------------------------------------------
// Agenda: what's coming, day by day, skipping empty days. An event over several days is listed on
// each, marked as continuing.
// ---------------------------------------------------------------------------

export const AGENDA_DAYS = 30

export function AgendaView({
  from,
  occurrences,
  calendars,
  now,
  selected,
  onSelect,
  renderCard,
  onNew,
}: {
  from: number
  occurrences: EventOccurrence[]
  calendars: Map<string, Calendar>
  now: number
  selected: string | null
  onSelect: (key: string | null) => void
  renderCard: (occurrence: EventOccurrence, side: 'left' | 'right') => React.ReactNode
  onNew: () => void
}) {
  const { C } = useSettings()
  const today = startOfDay(now)
  const days = useMemo(() => {
    const out: Array<{ day: number; items: EventOccurrence[] }> = []
    for (let i = 0, day = startOfDay(from); i < AGENDA_DAYS; i++, day = addDays(day, 1)) {
      const next = addDays(day, 1)
      const items = occurrences.filter((o) => {
        const s = displaySpan(o)
        return s.start < next && Math.max(s.end, s.start + 1) > day
      })
      // All-day first, then by start.
      items.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt - b.startAt)
      if (items.length) out.push({ day, items })
    }
    return out
  }, [from, occurrences])
  // An event over several days opens its card from the first day it's listed on.
  const first = useMemo(() => {
    const map = new Map<string, number>()
    for (const { day, items } of days) for (const o of items) if (!map.has(o.key)) map.set(o.key, day)
    return map
  }, [days])

  if (!days.length) {
    return (
      <div testId="agenda-empty" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <div style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: `${C.accent}1F`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="calendarDays" size={24} color={C.accent} />
        </div>
        <text style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>Nothing planned</text>
        <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>{`The next ${AGENDA_DAYS} days are free.`}</text>
        <div onClick={onNew} style={{ marginTop: 4, height: 30, paddingLeft: 12, paddingRight: 12, borderRadius: 15, backgroundColor: C.overlay, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}>
          <text style={{ fontSize: 12.5, fontWeight: 500, color: C.text, fontFamily: FONT, pointerEvents: 'none' }}>New event</text>
        </div>
      </div>
    )
  }

  return (
    // A month of busy days is hundreds of rows, and the whole window redraws every frame: a virtual
    // list builds only the days near the viewport (a full agenda took ~50 ms a frame). Remounted per
    // period, so paging starts at the top of the new one.
    <AgendaList key={from} count={days.length}>
      {(start, end) =>
        days.slice(start, end).map(({ day, items }, i) => {
          const isToday = day === today
          return (
            <div key={day} testId={`agenda-day-${new Date(day).getDate()}`} style={{ width: '100%', maxWidth: 880, paddingLeft: 28, paddingRight: 28, paddingTop: start + i === 0 ? 12 : 0, paddingBottom: start + i === days.length - 1 ? 40 : 0 }}>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 18, paddingTop: 14, paddingBottom: 14, borderBottomWidth: 1, borderColor: C.divider }}>
              <div style={{ width: 64, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingTop: 2 }}>
                <div style={{ minWidth: 32, height: 32, borderRadius: 16, backgroundColor: isToday ? C.accent : undefined, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <text style={{ fontSize: 19, fontWeight: 600, color: isToday ? C.onAccent : day < today ? C.muted : C.text, fontFamily: FONT }}>{dayNumber(day)}</text>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <text style={{ fontSize: 11.5, fontWeight: 600, color: isToday ? C.accent : C.secondary, fontFamily: FONT }}>{weekdayShort(day).toUpperCase()}</text>
                  <text style={{ fontSize: 11, color: C.muted, fontFamily: FONT }}>{monthShort(day)}</text>
                </div>
              </div>
              <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {items.map((o) => {
                  const span = displaySpan(o)
                  const continues = span.start < day
                  const color = solid(calendars.get(o.calendarId)?.color ?? C.accent, C)
                  const past = o.endAt <= now
                  const when = o.allDay ? 'All day' : continues ? `until ${timeText(span.end, true)}` : `${timeText(span.start, true)} – ${timeText(span.end, true)}`
                  return (
                    <Anchor key={`${o.key}:${day}`} card={selected === o.key && first.get(o.key) === day ? renderCard(o, 'right') : null}>
                      <div
                        testId={`event-${o.title}`}
                        onClick={() => onSelect(selected === o.key ? null : o.key)}
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 14,
                          minHeight: 40,
                          paddingLeft: 12,
                          paddingRight: 12,
                          paddingTop: 7,
                          paddingBottom: 7,
                          borderRadius: 10,
                          cursor: 'pointer',
                          backgroundColor: selected === o.key ? C.overlayStrong : undefined,
                          hover: { backgroundColor: C.overlay },
                        }}
                      >
                        <text style={{ width: 128, flexShrink: 0, fontSize: 12.5, color: past ? C.ghost : C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{when}</text>
                        <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: past ? 0.45 : 1, pointerEvents: 'none' }} />
                        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'none' }}>
                          <text style={{ fontSize: 13.5, fontWeight: 600, color: past ? C.muted : C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                            {o.title || 'Untitled event'}
                          </text>
                          {o.location || continues ? (
                            <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                              {[continues ? 'Continues' : null, o.location].filter(Boolean).join(' · ')}
                            </text>
                          ) : null}
                        </div>
                        {o.recurring ? (
                          <div style={{ pointerEvents: 'none', display: 'flex' }}>
                            <Icon name="repeat" size={13} color={C.ghost} />
                          </div>
                        ) : null}
                        {o.attendees.length ? (
                          <div style={{ pointerEvents: 'none', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Icon name="users" size={13} color={C.ghost} />
                            <text style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{String(o.attendees.length)}</text>
                          </div>
                        ) : null}
                      </div>
                    </Anchor>
                  )
                })}
              </div>
            </div>
            </div>
          )
        })
      }
    </AgendaList>
  )
}

const WINDOW = 10
const OVERDRAW = 3

/** The agenda's days in a <virtual-list>, mounting only the slice it asks for (plus a little overdraw). */
function AgendaList({ count, children }: { count: number; children: (start: number, end: number) => React.ReactNode }) {
  const [window, setWindow] = useState({ start: 0, end: WINDOW })
  const onVisibleRange = (event: { startIndex?: number; endIndex?: number }) => {
    const start = Math.max(0, (event.startIndex ?? 0) - OVERDRAW)
    const end = Math.max(start + WINDOW, (event.endIndex ?? 0) + OVERDRAW)
    if (start !== window.start || end !== window.end) setWindow({ start, end })
  }
  return (
    <virtual-list itemCount={count} estimatedItemHeight={120} windowStart={window.start} onVisibleRange={onVisibleRange} style={{ flexGrow: 1, minHeight: 0 }} testId="agenda-list">
      {children(window.start, window.end)}
    </virtual-list>
  )
}
