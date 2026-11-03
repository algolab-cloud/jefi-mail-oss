import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import type { Calendar, EventOccurrence } from '../engine'
import { FONT, useSettings, type Colors } from '../theme'
import { MINUTE, addDays, atMinutes, displaySpan, minutesOfDay, startOfDay } from './dates'
import { hourText, timeText, weekdayShort, dayNumber } from './format'
import { clockMinutes, isAllDayLike, layoutDay, layoutRow, recycleKeys, spanOf, stableKeys, type TimedBox } from './layout'
import { Anchor, DayBar, TimeBlock } from './event-chip'

// ---------------------------------------------------------------------------
// The week and day views: a day per column, an all-day row on top, and a scrolling 24-hour grid
// with a line at the current time. Events are dragged to move, their bottom edge to resize, and
// empty time dragged (or clicked) to make a new event there.
// ---------------------------------------------------------------------------

export const HOUR_HEIGHT = 52
const GUTTER = 58
const SNAP = 15
const ALL_DAY_LANES = 3

export type GridChange = { occurrence: EventOccurrence; start: number; end: number }

type Drag =
  | { kind: 'create'; day: number; anchor: number; x: number; y: number; moved: boolean; start: number; end: number }
  | { kind: 'move' | 'resize'; occurrence: EventOccurrence; grabDay: number; grabMinutes: number; x: number; y: number; moved: boolean; start: number; end: number }

type Column = { x: number; width: number; top: number }

export function TimeGrid({
  days,
  occurrences,
  calendars,
  now,
  weekend,
  selected,
  onSelect,
  renderCard,
  onCreate,
  onChange,
  onPickDay,
  canMove,
}: {
  days: number[]
  occurrences: EventOccurrence[]
  calendars: Map<string, Calendar>
  now: number
  weekend: number[]
  selected: string | null
  onSelect: (key: string | null) => void
  renderCard: (occurrence: EventOccurrence, side: 'left' | 'right') => React.ReactNode
  onCreate: (range: { start: number; end: number; allDay: boolean }) => void
  onChange: (change: GridChange) => void
  onPickDay: (day: number) => void
  /** What a drag may move; by default what's in a writable calendar. */
  canMove?: (o: EventOccurrence) => boolean
}) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const renderer = useGpuix().renderer
  const scrollRef = useRef<PublicInstance | null>(null)
  const columnRefs = useRef<Array<PublicInstance | null>>([])
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const setDragBoth = (next: Drag | null) => {
    dragRef.current = next
    setDrag(next)
  }
  const today = startOfDay(now)
  const rangeEnd = addDays(days[days.length - 1]!, 1)

  const { allDay, timed } = useMemo(() => {
    const allDay: EventOccurrence[] = []
    const timed: EventOccurrence[] = []
    for (const o of occurrences) (isAllDayLike(o) ? allDay : timed).push(o)
    return { allDay, timed }
  }, [occurrences])
  const byKey = useMemo(() => new Map(occurrences.map((o) => [o.key, o])), [occurrences])
  const bars = useMemo(() => layoutRow(allDay.map(spanOf), days), [allDay, days])
  const lanes = bars.reduce((n, b) => Math.max(n, b.lane + 1), 0)
  // By event where it's there once, so a weekly all-day event keeps its bar from week to week.
  const barIds = useMemo(() => stableKeys(bars.map((b) => byKey.get(b.key)!)), [bars, byKey])
  const shownLanes = Math.min(lanes, ALL_DAY_LANES)
  // One laid-out column per day, kept (same object) while its day and events are the same, so a
  // memoized column skips rendering when the week around it changes.
  const columnCache = useRef<ColumnLayout[]>([])
  const columns = useMemo(() => {
    const next = days.map((day, i) => columnLayout(columnCache.current[i], day, timed))
    columnCache.current = next
    return next
  }, [timed, days])

  // Open on the working day: 7:00, or an hour before now when today is on screen and it's later,
  // pulled earlier for an event before that. Only on mount, so moving between dates keeps the
  // position the person scrolled to.
  const workStart = days.includes(today) ? Math.max(7 * 60, minutesOfDay(now) - 60) : 7 * 60
  const firstMinutes = timed.reduce((m, o) => Math.min(m, o.startAt < days[0]! ? m : minutesOfDay(o.startAt)), workStart + 60)
  const scrollTarget = Math.max(0, Math.min(workStart, firstMinutes - 60))
  const target = useRef(scrollTarget)
  target.current = scrollTarget
  // Once, on mount; again shortly after, since the first layout (and the events) may not be in yet.
  // The pane keeps one grid across Day and Week so this doesn't need to survive a remount.
  useEffect(() => {
    const scroll = () => scrollRef.current && renderer?.scrollTo?.(scrollRef.current.id, 0, -Math.max(0, (target.current / 60) * HOUR_HEIGHT - 4))
    const timers = [30, 250, 700].map((ms) => setTimeout(scroll, ms))
    return () => timers.forEach(clearTimeout)
  }, [renderer])

  // --- Pointer geometry -------------------------------------------------------------
  const measure = (): Column[] | null => {
    if (!renderer?.getElementBounds) return null
    const out: Column[] = []
    for (const ref of columnRefs.current.slice(0, days.length)) {
      const b = ref ? renderer.getElementBounds(ref.id) : null
      if (!b) return null
      out.push({ x: b.x, width: b.width, top: b.y })
    }
    return out
  }
  const geometry = useRef<Column[] | null>(null)
  const dayAt = (x: number) => {
    const cols = geometry.current!
    let i = 0
    while (i < cols.length - 1 && x >= cols[i + 1]!.x) i++
    return i
  }
  const minutesAt = (y: number, round: 'floor' | 'round' = 'round') => {
    const raw = ((y - geometry.current![0]!.top) / HOUR_HEIGHT) * 60
    const snapped = (round === 'floor' ? Math.floor : Math.round)(raw / SNAP) * SNAP
    return Math.max(0, Math.min(24 * 60, snapped))
  }

  const begin = (next: (cols: Column[]) => Drag | null) => {
    const cols = measure()
    if (!cols) return
    geometry.current = cols
    setDragBoth(next(cols))
  }

  const startCreate = (dayIndex: number, event: { x?: number; y?: number }) => {
    // The press began on an event (it reaches the column too), or it closes an open card.
    if (dragRef.current) return
    if (selected) return onSelect(null)
    begin(() => {
      const anchor = minutesAt(event.y ?? 0, 'floor')
      const day = days[dayIndex]!
      return { kind: 'create', day, anchor, x: event.x ?? 0, y: event.y ?? 0, moved: false, start: atMinutes(day, anchor), end: atMinutes(day, anchor + 60) }
    })
  }
  const startMove = (o: EventOccurrence, kind: 'move' | 'resize', event: { x?: number; y?: number }) => {
    if (dragRef.current?.kind === 'resize') return
    begin(() => ({ kind, occurrence: o, grabDay: dayAt(event.x ?? 0), grabMinutes: minutesAt(event.y ?? 0), x: event.x ?? 0, y: event.y ?? 0, moved: false, start: o.startAt, end: o.endAt }))
  }

  const track = (event: { x?: number; y?: number }) => {
    const d = dragRef.current
    if (!d || !geometry.current) return
    const x = event.x ?? d.x
    const y = event.y ?? d.y
    // Something read-only (a subscribed calendar) only opens its card; dragging it would fail to save.
    if (d.kind !== 'create' && !movable(d.occurrence)) return
    const moved = d.moved || Math.abs(x - d.x) + Math.abs(y - d.y) > 4
    if (!moved) return
    if (d.kind === 'create') {
      const at = minutesAt(y)
      const from = Math.min(d.anchor, at)
      const to = Math.max(d.anchor + SNAP, at)
      setDragBoth({ ...d, moved, start: atMinutes(d.day, from), end: atMinutes(d.day, Math.min(to, 24 * 60)) })
    } else if (d.kind === 'move') {
      const shiftDays = dayAt(x) - d.grabDay
      const shiftMinutes = minutesAt(y) - d.grabMinutes
      const start = addDays(d.occurrence.startAt, shiftDays) + shiftMinutes * MINUTE
      setDragBoth({ ...d, moved, start, end: start + (d.occurrence.endAt - d.occurrence.startAt) })
    } else {
      const day = days[dayAt(x)]!
      const end = Math.max(d.occurrence.startAt + SNAP * MINUTE, atMinutes(day, minutesAt(y)))
      setDragBoth({ ...d, moved, end })
    }
  }

  const finish = () => {
    const d = dragRef.current
    setDragBoth(null)
    if (!d) return
    if (d.kind === 'create') return onCreate({ start: d.start, end: d.end, allDay: false })
    if (!d.moved) return onSelect(selected === d.occurrence.key ? null : d.occurrence.key)
    if (d.start !== d.occurrence.startAt || d.end !== d.occurrence.endAt) onChange({ occurrence: d.occurrence, start: d.start, end: d.end })
  }

  const writable = (o: EventOccurrence) => calendars.get(o.calendarId)?.canWrite !== false
  const movable = canMove ?? writable
  const moving = drag && drag.kind !== 'create' && drag.moved ? drag : null
  const weekendFill = dark ? '#FFFFFF04' : '#00000004'
  const showsToday = days.includes(today)

  // The columns get one set of callbacks for good, reading the latest state through a ref, so a
  // column whose day and events didn't change doesn't render again.
  const live = useRef({ startCreate, startMove, finish, renderCard, writable, count: days.length })
  live.current = { startCreate, startMove, finish, renderCard, writable, count: days.length }
  const handlers = useMemo<ColumnHandlers>(
    () => ({
      emptyDown: (index, event) => live.current.startCreate(index, event),
      up: () => void (dragRef.current && live.current.finish()),
      eventDown: (o, event) => live.current.startMove(o, 'move', event),
      resizeDown: (o, event) => live.current.startMove(o, 'resize', event),
      card: (o, index) => live.current.renderCard(o, index >= live.current.count / 2 && live.current.count > 1 ? 'left' : 'right'),
      writable: (o) => live.current.writable(o),
      ref: Array.from({ length: 7 }, (_, i) => (el: PublicInstance | null) => void (columnRefs.current[i] = el)),
    }),
    [],
  )

  return (
    // A quick click can release before the drag sheet is drawn; the release still ends it here.
    // Dragging events and drawing new ones mustn't select the text it passes over.
    <div onMouseUp={() => dragRef.current && finish()} style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', userSelect: 'none' }}>
      {/* Day headers */}
      <div style={{ display: 'flex', flexDirection: 'row', flexShrink: 0, paddingTop: 6, paddingBottom: 6, borderBottomWidth: shownLanes ? 0 : 1, borderColor: C.divider }}>
        <div style={{ width: GUTTER, flexShrink: 0 }} />
        {days.map((day, i) => {
          const isToday = day === today
          const past = day < today
          return (
            // Keyed by position: paging keeps the same seven headers and changes their text.
            <div key={i} testId={`grid-day-${new Date(day).getDate()}`} onClick={() => onPickDay(day)} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, cursor: 'pointer', borderRadius: 8, hover: { backgroundColor: C.overlay } }}>
              <text style={{ fontSize: 12, fontWeight: 500, color: isToday ? C.accent : past ? C.ghost : C.muted, fontFamily: FONT, pointerEvents: 'none' }}>{weekdayShort(day)}</text>
              <div style={{ minWidth: 28, height: 28, paddingLeft: 4, paddingRight: 4, borderRadius: 14, backgroundColor: isToday ? C.accent : undefined, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <text style={{ fontSize: 15, fontWeight: 600, color: isToday ? C.onAccent : past ? C.muted : C.text, fontFamily: FONT }}>{dayNumber(day)}</text>
              </div>
            </div>
          )
        })}
      </div>

      {/* All-day row */}
      {shownLanes ? (
        <div style={{ display: 'flex', flexDirection: 'row', flexShrink: 0, borderBottomWidth: 1, borderColor: C.divider, paddingBottom: 6 }}>
          <div style={{ width: GUTTER, flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', paddingRight: 10, paddingTop: 3 }}>
            <text style={{ fontSize: 10.5, color: C.ghost, fontFamily: FONT }}>all-day</text>
          </div>
          <div style={{ flexGrow: 1, minWidth: 0, position: 'relative', height: shownLanes * 23 + (lanes > shownLanes ? 16 : 0) }}>
            {/* Empty space in the row makes an all-day event on that day. */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'row' }}>
              {days.map((day, i) => (
                <div key={i} onClick={() => (selected ? onSelect(null) : onCreate({ start: day, end: addDays(day, 1), allDay: true }))} style={{ flexGrow: 1, flexBasis: 0, backgroundColor: '#00000001' }} />
              ))}
            </div>
            {bars
              .filter((b) => b.lane < shownLanes)
              .map((bar) => {
                const o = byKey.get(bar.key)!
                return (
                  <div key={barIds.get(bar.key)} style={{ position: 'absolute', top: bar.lane * 23, left: 0, right: 0, display: 'flex', flexDirection: 'row', pointerEvents: 'none' }}>
                    <div style={{ flexGrow: bar.from, flexBasis: 0 }} />
                    <div style={{ flexGrow: bar.to - bar.from, flexBasis: 0, minWidth: 0, paddingLeft: 2, paddingRight: 3, pointerEvents: 'auto' }}>
                      <Anchor card={selected === o.key ? renderCard(o, bar.from > days.length / 2 ? 'left' : 'right') : null}>
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
                    <div style={{ flexGrow: days.length - bar.to, flexBasis: 0 }} />
                  </div>
                )
              })}
            {lanes > shownLanes ? (
              <div style={{ position: 'absolute', top: shownLanes * 23, left: 0, right: 0, height: 14, display: 'flex', flexDirection: 'row', pointerEvents: 'none' }}>
                {days.map((day, i) => {
                  const hidden = bars.filter((b) => b.lane >= shownLanes && b.from <= i && b.to > i).length
                  return (
                    <div key={i} style={{ flexGrow: 1, flexBasis: 0, paddingLeft: 6 }}>
                      {hidden ? <text style={{ fontSize: 10.5, fontWeight: 500, color: C.muted, fontFamily: FONT }}>{`+${hidden} more`}</text> : null}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The hours */}
      <div ref={(el) => void (scrollRef.current = el)} style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll' }}>
        <div style={{ height: 24 * HOUR_HEIGHT + 12, display: 'flex', flexDirection: 'row', position: 'relative', paddingTop: 6, paddingBottom: 6 }}>
          <Gutter now={showsToday ? now : null} C={C} />
          <div style={{ flexGrow: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'row' }}>
            <HourLines color={C.divider} />
            {days.map((day, i) => {
              const column = columns[i]!
              return (
                // Keyed by position, not date: paging keeps the columns (and the events that stay).
                <DayColumn
                  key={i}
                  index={i}
                  column={column}
                  calendars={calendars}
                  now={now}
                  isToday={day === today}
                  weekend={weekend.includes(new Date(day).getDay())}
                  weekendFill={weekendFill}
                  selected={selected && column.keys.has(selected) ? selected : null}
                  moving={moving && column.keys.has(moving.occurrence.key) ? moving.occurrence.key : null}
                  handlers={handlers}
                />
              )
            })}
            {/* Where a drag is going (or the new event being drawn), over the columns. */}
            {drag && drag.moved ? <DragPreview drag={drag} days={days} rangeEnd={rangeEnd} calendars={calendars} /> : null}
          </div>
        </div>
      </div>

      {/* GPUIX has no pointer capture: while dragging, a sheet over the grid takes every move and the release. */}
      {drag ? (
        <div
          onMouseMove={(event) => (event.pressedButton === undefined || event.pressedButton === null ? finish() : track(event))}
          onMouseUp={(event) => {
            track(event)
            finish()
          }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000001', cursor: drag.kind === 'resize' ? 'ns-resize' : drag.moved && drag.kind === 'move' ? 'grabbing' : 'default' }}
        />
      ) : null}
    </div>
  )
}

type ColumnHandlers = {
  emptyDown: (index: number, event: { x?: number; y?: number }) => void
  up: () => void
  eventDown: (o: EventOccurrence, event: { x?: number; y?: number }) => void
  resizeDown: (o: EventOccurrence, event: { x?: number; y?: number }) => void
  card: (o: EventOccurrence, index: number) => React.ReactNode
  writable: (o: EventOccurrence) => boolean
  ref: Array<(el: PublicInstance | null) => void>
}

/** A day's timed events laid out, with a React key per event and the occurrence keys it holds. */
type ColumnLayout = { day: number; events: EventOccurrence[]; items: Array<{ box: TimedBox; o: EventOccurrence; id: string }>; keys: Set<string> }

/** `prev` again when the day and its events are the same objects, so the memoized column skips. */
function columnLayout(prev: ColumnLayout | undefined, day: number, timed: EventOccurrence[]): ColumnLayout {
  const end = addDays(day, 1)
  const events = timed.filter((o) => o.endAt > day && o.startAt < end)
  if (prev && prev.day === day && prev.events.length === events.length && prev.events.every((o, i) => o === events[i])) return prev
  const byKey = new Map(events.map((o) => [o.key, o]))
  const boxes = layoutDay(events.map((o) => ({ key: o.key, start: o.startAt, end: o.endAt })), day, end)
  const ordered = boxes.map((box) => byKey.get(box.key)!)
  const ids = recycleKeys(prev?.items.map(({ o, id }) => ({ key: o.key, id: o.id, slot: id })) ?? [], ordered)
  return { day, events, items: boxes.map((box, i) => ({ box, o: ordered[i]!, id: ids.get(box.key)! })), keys: new Set(byKey.keys()) }
}

const DayColumn = memo(function DayColumn({
  index,
  column,
  calendars,
  now,
  isToday,
  weekend,
  weekendFill,
  selected,
  moving,
  handlers,
}: {
  index: number
  column: ColumnLayout
  calendars: Map<string, Calendar>
  now: number
  isToday: boolean
  weekend: boolean
  weekendFill: string
  /** The open card's occurrence, when it's in this column; the one being dragged, likewise. */
  selected: string | null
  moving: string | null
  handlers: ColumnHandlers
}) {
  const { C } = useSettings()
  return (
    <div
      ref={handlers.ref[index]}
      testId={`grid-column-${index}`}
      onMouseDown={(event) => handlers.emptyDown(index, event)}
      onMouseUp={handlers.up}
      style={{
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        height: 24 * HOUR_HEIGHT,
        position: 'relative',
        backgroundColor: weekend ? weekendFill : '#00000001',
      }}
    >
      {/* The column's edge as its first child, not a border: GPUI paints a border over the children,
          which cut through the now line's dot. */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 1, backgroundColor: C.divider, pointerEvents: 'none' }} />
      {column.items.map(({ box, o, id }) => (
        <GridEvent
          key={id}
          box={box}
          o={o}
          index={index}
          calendar={calendars.get(o.calendarId)}
          past={o.endAt <= now}
          selected={selected === o.key}
          ghost={moving === o.key}
          canEdit={handlers.writable(o)}
          handlers={handlers}
        />
      ))}
      {isToday ? (
        <div style={{ position: 'absolute', top: (minutesOfDay(now) / 60) * HOUR_HEIGHT - 1, left: -5, right: 0, height: 10, display: 'flex', flexDirection: 'row', alignItems: 'center', pointerEvents: 'none' }}>
          <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent, marginTop: -8 }} />
          <div style={{ flexGrow: 1, height: 2, backgroundColor: C.accent, marginTop: -8 }} />
        </div>
      ) : null}
    </div>
  )
})

/** One timed event in its column, in its share of the width. */
const GridEvent = memo(function GridEvent({
  box,
  o,
  index,
  calendar,
  past,
  selected,
  ghost,
  canEdit,
  handlers,
}: {
  box: TimedBox
  o: EventOccurrence
  index: number
  calendar: Calendar | undefined
  past: boolean
  selected: boolean
  ghost: boolean
  canEdit: boolean
  handlers: ColumnHandlers
}) {
  const top = (box.top / 60) * HOUR_HEIGHT
  const height = Math.max(((box.bottom - box.top) / 60) * HOUR_HEIGHT - 2, 20)
  return (
    <div style={{ position: 'absolute', top: top + 1, left: 0, right: 0, height, display: 'flex', flexDirection: 'row', paddingLeft: 2, paddingRight: 4, pointerEvents: 'none' }}>
      <div style={{ flexGrow: box.col, flexBasis: 0 }} />
      <div style={{ flexGrow: box.span, flexBasis: 0, minWidth: 0, paddingRight: box.col + box.span < box.cols ? 2 : 0, pointerEvents: 'auto' }}>
        <Anchor card={selected ? handlers.card(o, index) : null}>
          <TimeBlock
            occurrence={o}
            calendar={calendar}
            height={height}
            past={past}
            selected={selected}
            ghost={ghost}
            onMouseDown={(event) => handlers.eventDown(o, event)}
            onMouseUp={handlers.up}
            onResizeDown={canEdit && !box.clippedEnd && !o.allDay ? (event) => handlers.resizeDown(o, event) : undefined}
            testId={`event-${o.title}`}
          />
        </Anchor>
      </div>
      <div style={{ flexGrow: box.cols - box.col - box.span, flexBasis: 0 }} />
    </div>
  )
})

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

/** Hour labels, each on its line; the now pill (when today is on screen) replaces one it would overlap. */
const Gutter = memo(function Gutter({ now, C }: { now: number | null; C: Colors }) {
  return (
    <div style={{ width: GUTTER, flexShrink: 0, position: 'relative' }}>
      {HOURS.slice(1)
        .filter((hour) => now === null || Math.abs(minutesOfDay(now) - hour * 60) >= 18)
        .map((hour) => (
          <div key={hour} style={{ position: 'absolute', top: hour * HOUR_HEIGHT - 7, right: 10, height: 14, display: 'flex', alignItems: 'center' }}>
            <text style={{ fontSize: 10.5, color: C.ghost, fontFamily: FONT, whiteSpace: 'nowrap' }}>{hourText(hour)}</text>
          </div>
        ))}
      {now !== null ? (
        <div style={{ position: 'absolute', top: (minutesOfDay(now) / 60) * HOUR_HEIGHT - 9, right: 4, height: 18, paddingLeft: 5, paddingRight: 5, borderRadius: 9, backgroundColor: C.accent, display: 'flex', alignItems: 'center' }}>
          <text style={{ fontSize: 10.5, fontWeight: 600, color: C.onAccent, fontFamily: FONT, whiteSpace: 'nowrap' }}>{timeText(now)}</text>
        </div>
      ) : null}
    </div>
  )
})

/** Hour lines, under everything. */
const HourLines = memo(function HourLines({ color }: { color: string }) {
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 24 * HOUR_HEIGHT, pointerEvents: 'none' }}>
      {HOURS.map((hour) => (
        <div key={hour} style={{ position: 'absolute', top: hour * HOUR_HEIGHT, left: 0, right: 0, height: 1, backgroundColor: hour === 0 ? 'transparent' : color }} />
      ))}
    </div>
  )
})

/** The event where a drag would put it, drawn over the grid in the columns it covers. */
function DragPreview({ drag, days, rangeEnd, calendars }: { drag: Drag; days: number[]; rangeEnd: number; calendars: Map<string, Calendar> }) {
  const { C } = useSettings()
  if (drag.end <= days[0]! || drag.start >= rangeEnd) return null
  const occurrence = drag.kind === 'create' ? null : drag.occurrence
  const calendar = occurrence ? calendars.get(occurrence.calendarId) : undefined
  const label = `${timeText(drag.start, true)} – ${timeText(drag.end, true)}`
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 24 * HOUR_HEIGHT, display: 'flex', flexDirection: 'row', pointerEvents: 'none' }}>
      {days.map((day, i) => {
        const end = addDays(day, 1)
        if (drag.end <= day || drag.start >= end) return <div key={i} style={{ flexGrow: 1, flexBasis: 0 }} />
        const from = Math.max(drag.start, day)
        const to = Math.min(drag.end, end)
        // Clock minutes, like the boxes it previews (a DST day isn't 24 hours long).
        const top = (clockMinutes(from, day) / 60) * HOUR_HEIGHT
        const height = Math.max(((clockMinutes(to, day) - clockMinutes(from, day)) / 60) * HOUR_HEIGHT - 2, 20)
        return (
          <div key={i} style={{ flexGrow: 1, flexBasis: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', top: top + 1, left: 3, right: 5 }}>
              <TimeBlock
                occurrence={occurrence ?? { title: 'New event', startAt: drag.start, endAt: drag.end, location: null, status: 'confirmed' }}
                calendar={calendar ?? ({ color: C.accent } as Calendar)}
                height={height}
                past={false}
                selected
                timeLabel={label}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
