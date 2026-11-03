import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { EventOccurrence } from '../engine'
import type { EventPrefill } from './draft'
import { addDays, addMonths, allDayToLocal, startOfDay } from './dates'

// ---------------------------------------------------------------------------
// The calendar's UI state, kept in a module rather than in the mail workspace: where the calendar
// is looking survives leaving it and coming back, and any part of the app (the reader's "Add to
// calendar") can open the event editor without threading callbacks through the mail UI. Nothing
// here re-renders mail components; only the calendar's own readers subscribe.
// ---------------------------------------------------------------------------

export type CalendarView = 'month' | 'week' | 'day' | 'agenda'

/** The editor: a new event (with a prefill) or an existing occurrence. */
export type EditorState = { key: number; prefill: EventPrefill; occurrence?: undefined } | { key: number; occurrence: EventOccurrence; prefill?: undefined }

export type CalendarUiState = {
  view: CalendarView
  /** Any instant in the period on screen; the day view shows its day. */
  cursor: number
  editor: EditorState | null
  /** The occurrence whose detail card is open, by key. */
  selected: string | null
}

let state: CalendarUiState = { view: 'week', cursor: Date.now(), editor: null, selected: null }
const listeners = new Set<() => void>()

export const calendarState = () => state

export function setCalendarState(patch: Partial<CalendarUiState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function useCalendarState<T>(read: (s: CalendarUiState) => T): T {
  return useSyncExternalStore(subscribe, () => read(state))
}

let editorKey = 0

/**
 * Opens the event editor over whatever is on screen, filled in with `prefill`. The editor is mounted
 * at the app shell, so this works from the reader as well as the calendar. Saving links `link`.
 */
export function openEventEditor(prefill: EventPrefill = {}) {
  setCalendarState({ editor: { key: ++editorKey, prefill }, selected: null })
}

/** Opens the editor on an existing occurrence (a series asks which occurrences a change covers on save). */
export function editOccurrence(occurrence: EventOccurrence) {
  setCalendarState({ editor: { key: ++editorKey, occurrence }, selected: null })
}

export const closeEventEditor = () => setCalendarState({ editor: null })

// --- Showing the calendar from elsewhere ---------------------------------------------------------

/** A day to show, optionally in another view, and the occurrence (by key) whose card to open there. */
export type CalendarRequest = { date?: number; select?: string; view?: CalendarView }

const requestListeners = new Set<(request: CalendarRequest) => void>()

/** Opens the calendar view (the workspace listens), on `date` with `select`'s card open. */
export function requestCalendar(request: CalendarRequest = {}) {
  setCalendarState({ ...(request.date !== undefined ? { cursor: request.date } : {}), ...(request.view ? { view: request.view } : {}), selected: request.select ?? null, editor: null })
  for (const listener of requestListeners) listener(request)
}

/**
 * Shows an event in the calendar with its card open. A series opens on its first occurrence's day
 * without a card, since which occurrence was meant isn't known.
 */
export function showEvent(event: Pick<EventOccurrence, 'id' | 'startAt' | 'allDay' | 'recurrence'> & { key?: string }) {
  const date = event.allDay ? allDayToLocal(event.startAt) : event.startAt
  requestCalendar({ date, select: event.key ?? (event.recurrence ? undefined : event.id) })
}

export function useCalendarRequests(handler: (request: CalendarRequest) => void) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const listener = (request: CalendarRequest) => ref.current(request)
    requestListeners.add(listener)
    return () => void requestListeners.delete(listener)
  }, [])
}

/** One step of the view's period back (-1) or forward (1). */
export function stepCursor(view: CalendarView, cursor: number, direction: -1 | 1): number {
  if (view === 'month') return addMonths(cursor, direction)
  if (view === 'week') return addDays(cursor, 7 * direction)
  if (view === 'agenda') return addDays(cursor, 14 * direction)
  return addDays(startOfDay(cursor), direction)
}
