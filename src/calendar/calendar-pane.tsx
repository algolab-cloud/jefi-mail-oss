import { memo, useEffect, useMemo, useState } from 'react'
import type { EventOccurrence, SeriesScope } from '../engine'
import { FONT, TOPBAR_HEIGHT, mixHex, useSettings } from '../theme'
import { Icon, IconButton } from '../icons'
import { useKeys } from '../keys'
import { overlaysOpen, useOverlay } from '../overlays'
import { useCachedEvents, useCalendarRevision, useEvents, usePrefetchEvents } from '../local-data'
import { useMailActions } from '../store'
import { TASKS_CALENDAR_ID, TaskCalendarCard, isTaskOccurrence, tasksCalendar, useCalendarTasks } from '../tasks/calendar'
import { SegmentedControl } from '../ui'
import { addDays, displaySpan, monthGrid, startOfDay, startOfWeek } from './dates'
import { rangeTitle, solid, timeText, dayLine } from './format'
import { ruleForDay } from './draft'
import { useCalendarMap, useNow, useWeekInfo } from './hooks'
import { calendarActionFor } from './keys'
import { MiniMonth } from './mini-month'
import { CalendarList } from './calendar-list'
import { TimeGrid, type GridChange } from './time-grid'
import { MonthView } from './month-view'
import { AGENDA_DAYS, AgendaView } from './agenda-view'
import { EventCard, ScopeChoice } from './event-card'
import { Popover, closePopover } from './fields'
import { calendarState, editOccurrence, openEventEditor, setCalendarState, stepCursor, useCalendarState, type CalendarView as ViewName } from './state'

// ---------------------------------------------------------------------------
// The calendar, where the mail list and reader usually are: a rail with a month to jump around,
// the calendars and what's next, and the view itself under a toolbar. It reads only calendar data
// (local-data.ts), so mail syncing never re-renders it, and saving an event never re-renders mail.
// ---------------------------------------------------------------------------

const VIEWS: Array<{ value: ViewName; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'agenda', label: 'Agenda' },
]

/** The days a view shows, and the range to fetch for them. */
export function visibleRange(view: ViewName, cursor: number, firstDay: 0 | 1 | 2 | 3 | 4 | 5 | 6): { days: number[]; from: number; to: number } {
  const days =
    view === 'month'
      ? monthGrid(cursor, firstDay)
      : view === 'week'
        ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor, firstDay), i))
        : view === 'day'
          ? [startOfDay(cursor)]
          : Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(startOfDay(cursor), i))
  return { days, from: days[0]!, to: addDays(days[days.length - 1]!, 1) }
}

const go = (patch: { view?: ViewName; cursor?: number }) => setCalendarState({ ...patch, selected: null })

/**
 * What paging or switching views from here would show next: the periods either side, the other
 * views of this day, and the rail's month for each (its dots query the same range as a month view).
 */
export function nearbyRanges(view: ViewName, cursor: number, firstDay: 0 | 1 | 2 | 3 | 4 | 5 | 6): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  for (const at of [stepCursor(view, cursor, 1), stepCursor(view, cursor, -1)]) {
    out.push(visibleRange(view, at, firstDay))
    if (view !== 'month') out.push(visibleRange('month', at, firstDay))
  }
  for (const other of VIEWS) if (other.value !== view) out.push(visibleRange(other.value, cursor, firstDay))
  return out.map(({ from, to }) => ({ from, to }))
}

/** A new event: the next half hour today; 9:00 on the day on screen when that's another day. */
export function newEventOnScreen() {
  const { view, cursor } = calendarState()
  const day = startOfDay(cursor)
  if ((view === 'day' || view === 'week') && day !== startOfDay(Date.now())) {
    const start = new Date(day).setHours(9, 0, 0, 0)
    openEventEditor({ start, end: start + 3_600_000 })
  } else openEventEditor()
}

/** The whole calendar: its sidebar beside the view. The app shell can also place the two apart. */
export const CalendarPane = memo(function CalendarPane() {
  const { C } = useSettings()
  return (
    <div testId="calendar-pane" style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'row', backgroundColor: C.reading }}>
      <CalendarSidebar />
      <CalendarView />
    </div>
  )
})

/** The calendar itself: toolbar and the day, week, month or agenda under it, with its keys. */
export const CalendarView = memo(function CalendarView() {
  const { C } = useSettings()
  const view = useCalendarState((s) => s.view)
  const cursor = useCalendarState((s) => s.cursor)
  const selected = useCalendarState((s) => s.selected)
  const editorOpen = useCalendarState((s) => !!s.editor)
  const { firstDay, weekend } = useWeekInfo()
  const now = useNow()
  const eventCalendars = useCalendarMap()
  const { saveEvent, saveTask } = useMailActions()
  const { days, from, to } = useMemo(() => visibleRange(view, cursor, firstDay), [view, cursor, firstDay])
  // Cached, and the ranges around it fetched ahead once it's in, so paging is a single render.
  const events = useCachedEvents(from, to)
  const prefetch = usePrefetchEvents()
  const calendarRev = useCalendarRevision()
  const loaded = events !== null
  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => prefetch(nearbyRanges(view, cursor, firstDay)), 120)
    return () => clearTimeout(timer)
  }, [loaded, view, cursor, firstDay, calendarRev, prefetch])
  // Tasks with a due date ride along on a read-only Tasks calendar (src/tasks/calendar.tsx).
  const taskLayer = useCalendarTasks(from, to)
  const occurrences = useMemo(() => [...(events ?? []), ...taskLayer.occurrences].sort((a, b) => a.startAt - b.startAt), [events, taskLayer.occurrences])
  const calendars = useMemo(() => new Map([...eventCalendars, [TASKS_CALENDAR_ID, tasksCalendar(C.accent)]]), [eventCalendars, C.accent])
  const [pending, setPending] = useState<GridChange | null>(null)
  const [picker, setPicker] = useState(false)

  const select = (key: string | null) => setCalendarState({ selected: key })
  const newEvent = newEventOnScreen

  const applyChange = async (change: GridChange, scope?: SeriesScope) => {
    const o = change.occurrence
    setPending(null)
    // A task on the calendar moves its due time.
    if (isTaskOccurrence(o)) return void (await saveTask({ id: o.id, dueAt: change.start, dueAllDay: false }))
    // Moving a series to another weekday takes an "every Tuesday" rule along with it.
    const rule = o.recurring && scope !== 'this' ? ruleForDay(o.recurrence, startOfDay(o.startAt), startOfDay(change.start)) : o.recurrence
    await saveEvent(
      { id: o.id, title: o.title, startAt: change.start, endAt: change.end, allDay: o.allDay, ...(rule !== o.recurrence ? { recurrence: rule } : {}) },
      o.recurring ? { scope: scope ?? 'all', occurrenceStart: o.occurrenceStart } : undefined,
    )
  }

  useKeys((press, { typing }) => {
    // The date jump under the title closes on Escape (the editor handles its own).
    if (!editorOpen && press.key?.toLowerCase() === 'escape' && closePopover()) return true
    const action = calendarActionFor(press, { typing, busy: editorOpen || (overlaysOpen() && !selected) || !!pending })
    if (!action) return
    const state = calendarState()
    switch (action) {
      case 'today':
        go({ cursor: Date.now() })
        break
      case 'previous':
      case 'next':
        go({ cursor: stepCursor(state.view, state.cursor, action === 'next' ? 1 : -1) })
        break
      case 'new':
        newEvent()
        break
      case 'close':
        if (!state.selected) return
        select(null)
        break
      default:
        go({ view: action })
    }
    return true
  })

  const renderCard = (o: EventOccurrence, side: 'left' | 'right') => {
    if (isTaskOccurrence(o)) {
      const task = taskLayer.tasks.find((t) => t.id === o.id)
      return task ? <TaskCalendarCard task={task} side={side} onClose={() => select(null)} /> : null
    }
    return renderEventCard(o, side)
  }
  const renderEventCard = (o: EventOccurrence, side: 'left' | 'right') => (
    <EventCard
      occurrence={o}
      calendar={calendars.get(o.calendarId)}
      side={side}
      onClose={() => select(null)}
      onEdit={() => editOccurrence(o)}
      onDeleted={() => select(null)}
    />
  )
  const create = (range: { start: number; end: number; allDay: boolean }) => openEventEditor(range)
  const pickDay = (day: number) => go({ view: 'day', cursor: day })

  return (
      <div testId="calendar-view" style={{ flexGrow: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', backgroundColor: C.reading }}>
        {/* Toolbar */}
        <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 18, paddingRight: 16, borderBottomWidth: view === 'month' || view === 'agenda' ? 1 : 0, borderColor: C.divider }}>
          <div style={{ position: 'relative', display: 'flex' }}>
            <div
              testId="calendar-title"
              onClick={() => setPicker((v) => !v)}
              style={{ height: 34, paddingLeft: 8, paddingRight: 6, marginLeft: -8, borderRadius: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
            >
              <text style={{ fontSize: 18, fontWeight: 650, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{rangeTitle(view, cursor, firstDay)}</text>
              <div style={{ pointerEvents: 'none', display: 'flex', paddingTop: 2 }}>
                <Icon name="chevronDown" size={14} color={C.muted} />
              </div>
            </div>
            <Popover open={picker} onClose={() => setPicker(false)} width={260} testId="calendar-jump">
              <MiniMonth
                value={cursor}
                firstDay={firstDay}
                onPick={(day) => {
                  setPicker(false)
                  go({ cursor: day })
                }}
              />
            </Popover>
          </div>
          <div style={{ flexGrow: 1 }} />
          <div
            testId="calendar-today"
            onClick={() => go({ cursor: Date.now() })}
            style={{ height: 30, paddingLeft: 12, paddingRight: 12, borderRadius: 15, backgroundColor: C.overlay, display: 'flex', alignItems: 'center', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
          >
            <text style={{ fontSize: 12.5, fontWeight: 500, color: C.text, fontFamily: FONT, pointerEvents: 'none' }}>Today</text>
          </div>
          <IconButton icon="chevronLeft" size={16} pad={30} tooltip="Previous (K)" onClick={() => go({ cursor: stepCursor(view, cursor, -1) })} testId="calendar-prev" />
          <IconButton icon="chevronRight" size={16} pad={30} tooltip="Next (J)" onClick={() => go({ cursor: stepCursor(view, cursor, 1) })} testId="calendar-next" />
          <div style={{ width: 8 }} />
          <SegmentedControl value={view} options={VIEWS} onChange={(next) => go({ view: next })} testId="calendar-view" />
          <div style={{ width: 4 }} />
          <div
            testId="calendar-new"
            onClick={newEvent}
            style={{ height: 30, paddingLeft: 10, paddingRight: 12, borderRadius: 15, backgroundColor: C.text, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer', hover: { backgroundColor: mixHex(C.text, C.reading, 0.12) }, active: { backgroundColor: mixHex(C.text, C.reading, 0.22) } }}
          >
            <div style={{ pointerEvents: 'none', display: 'flex' }}>
              <Icon name="plus" size={14} color={C.onText} />
            </div>
            <text style={{ fontSize: 12.5, fontWeight: 600, color: C.onText, fontFamily: FONT, pointerEvents: 'none', whiteSpace: 'nowrap' }}>New event</text>
          </div>
        </div>

        {view === 'month' ? (
          <MonthView grid={days} cursor={cursor} occurrences={occurrences} calendars={calendars} now={now} weekend={weekend} selected={selected} onSelect={select} renderCard={renderCard} onCreate={create} onPickDay={pickDay} />
        ) : view === 'agenda' ? (
          <AgendaView from={from} occurrences={occurrences} calendars={calendars} now={now} selected={selected} onSelect={select} renderCard={renderCard} onNew={newEvent} />
        ) : (
          // No key per view: GPUIX drops scrollTo on a scroll container that replaces another in
          // the same frame, so a fresh Day grid stayed at midnight. One grid keeps the offset too.
          <TimeGrid
            days={days}
            occurrences={occurrences}
            calendars={calendars}
            now={now}
            weekend={weekend}
            selected={selected}
            onSelect={select}
            renderCard={renderCard}
            onCreate={create}
            onChange={(change) => (change.occurrence.recurring ? setPending(change) : void applyChange(change))}
            onPickDay={pickDay}
            canMove={(o) => isTaskOccurrence(o) || calendars.get(o.calendarId)?.canWrite !== false}
          />
        )}
        {pending ? <ScopeSheet change={pending} onPick={(scope) => void applyChange(pending, scope)} onCancel={() => setPending(null)} /> : null}
    </div>
  )
})

/** Which occurrences a drag on a repeating event changes. */
function ScopeSheet({ change, onPick, onCancel }: { change: GridChange; onPick: (scope: SeriesScope) => void; onCancel: () => void }) {
  const { C, settings } = useSettings()
  useOverlay(true)
  useKeys((press) => {
    if (press.key?.toLowerCase() !== 'escape') return false
    onCancel()
    return true
  })
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: settings.theme === 'dark' ? '#00000066' : '#00000033' }} onClick={onCancel} />
      <div testId="calendar-scope" style={{ width: 320, borderRadius: 14, backgroundColor: C.raised, borderWidth: 1, borderColor: C.overlayStrong, padding: 8, display: 'flex', flexDirection: 'column', gap: 2, boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 40, spreadRadius: 0, color: '#00000055' } }}>
        <div style={{ paddingLeft: 10, paddingTop: 8, paddingBottom: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <text style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: FONT }}>{`Move “${change.occurrence.title}”`}</text>
          <text style={{ fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{`It repeats. Move it to ${dayLine(change.start)}, ${timeText(change.start)} for…`}</text>
        </div>
        <ScopeChoice label="Only this event" onSelect={() => onPick('this')} testId="move-this" />
        <ScopeChoice label="This and following events" onSelect={() => onPick('following')} testId="move-following" />
        <ScopeChoice label="All events in the series" onSelect={() => onPick('all')} testId="move-all" />
        <ScopeChoice label="Cancel" onSelect={onCancel} />
      </div>
    </div>
  )
}

/** Beside the view: new event, a month to jump around, the calendars, and what's next. Self-contained. */
/** `embedded` fills the app shell's context column (its width, the sidebar's colour) instead of its own 256 px. */
export const CalendarSidebar = memo(function CalendarSidebar({ embedded = false }: { embedded?: boolean }) {
  const { C } = useSettings()
  const { firstDay } = useWeekInfo()
  const view = useCalendarState((s) => s.view)
  const cursor = useCalendarState((s) => s.cursor)
  const now = useNow()
  const onPick = (day: number) => go({ cursor: day })
  const onNew = newEventOnScreen
  const days = view === 'week' ? visibleRange(view, cursor, firstDay).days : null
  const highlight = days ? { from: days[0]!, to: addDays(days[6]!, 1) } : undefined
  return (
    <div testId="calendar-sidebar" style={{ width: embedded ? '100%' : 256, flexShrink: embedded ? 1 : 0, flexGrow: embedded ? 1 : 0, height: embedded ? undefined : '100%', minHeight: 0, display: 'flex', flexDirection: 'column', backgroundColor: embedded ? C.sidebar : C.list, borderRightWidth: embedded ? 0 : 1, borderColor: C.divider }}>
      <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 12 }}>
        <text style={{ flexGrow: 1, fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>Calendar</text>
        <IconButton icon="calendarPlus" size={16} pad={30} tooltip="New event (N)" onClick={onNew} testId="calendar-rail-new" />
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll', display: 'flex', flexDirection: 'column', paddingLeft: 12, paddingRight: 12, gap: 18 }}>
        <MiniMonth value={cursor} firstDay={firstDay} onPick={onPick} highlight={highlight} testId="mini-month" />
        <div style={{ height: 1, backgroundColor: C.divider, marginLeft: 6, marginRight: 6 }} />
        <CalendarList />
      </div>
      <UpNext now={now} />
    </div>
  )
})

/** The next thing on the calendar (within a week), so the rail answers "what's next?" at a glance. */
function UpNext({ now }: { now: number }) {
  const { C } = useSettings()
  const calendars = useCalendarMap()
  // A stable range per minute, so this refetches only as time moves on.
  const upcoming = useEvents(now, addDays(now, 7))
  const next = upcoming?.find((o) => !o.allDay && o.endAt > now) ?? upcoming?.find((o) => displaySpan(o).end > now)
  if (!next) return null
  const color = solid(calendars.get(next.calendarId)?.color ?? C.accent, C)
  // Rounded up, so something starting in 20 seconds isn't "In 0 min".
  const minutes = Math.ceil((next.startAt - now) / 60_000)
  const when = next.allDay
    ? dayLine(displaySpan(next).start)
    : next.startAt <= now
      ? `Now · until ${timeText(next.endAt)}`
      : minutes < 60
        ? `In ${minutes} min · ${timeText(next.startAt)}`
        : startOfDay(next.startAt) === startOfDay(now)
          ? `Today · ${timeText(next.startAt)}`
          : startOfDay(next.startAt) === addDays(startOfDay(now), 1)
            ? `Tomorrow · ${timeText(next.startAt)}`
            : `${dayLine(next.startAt)} · ${timeText(next.startAt)}`
  return (
    <div
      testId="calendar-up-next"
      onClick={() => setCalendarState({ cursor: next.startAt, selected: next.key })}
      style={{ position: 'relative', margin: 12, marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: C.raised, display: 'flex', flexDirection: 'row', gap: 10, cursor: 'pointer', hover: { backgroundColor: C.raisedHover } }}
    >
      <div style={{ position: 'absolute', top: 10, right: 10, width: 6, height: 6, borderRadius: 3, backgroundColor: color, pointerEvents: 'none' }} />
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, pointerEvents: 'none' }}>
        <text style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, fontFamily: FONT }}>UP NEXT</text>
        <text style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{next.title || 'Untitled event'}</text>
        <text style={{ fontSize: 12, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{when}</text>
      </div>
    </div>
  )
}
