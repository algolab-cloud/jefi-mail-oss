import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Calendar, CalendarEvent, EngineEvent, EventOccurrence, InviteSummary, MailEngine, Note, Task, TaskLabel, TaskProject, TaskQuery } from './engine'
import { arrivedInvites, inviteRecent, pushRecent } from './menubar-data'
import { reuseUnchangedItems } from './store-equality'

// ---------------------------------------------------------------------------
// Calendars, notes and tasks on the UI side. Kept outside MailProvider's React state on purpose: a
// saved event, note or task re-renders only the components that read that data (through the hooks
// below), never every useMail() consumer. The engine's calendarChanged / notesChanged / tasksChanged
// events bump a revision; queries keyed on it fetch again. Writes go through the MailStore actions (useMailActions).
// ---------------------------------------------------------------------------

export type LocalData = {
  engine: Pick<MailEngine, 'listCalendars' | 'listEvents' | 'listNotes' | 'notesForThread' | 'eventsForThread' | 'notesForEvent' | 'pendingInvites' | 'listTasks' | 'tasksForThread' | 'listTaskProjects' | 'listTaskLabels'>
  calendars: Calendar[]
  /** Invitations waiting for an answer (engine.pendingInvites); null before the first answer. */
  pendingInvites: InviteSummary[] | null
  /** Bumped by every calendarChanged event. */
  calendarRev: number
  /** Bumped by every notesChanged event. */
  notesRev: number
  /** Bumped by every tasksChanged event. */
  tasksRev: number
  listeners: Set<() => void>
}

export function createLocalData(engine: LocalData['engine']): LocalData {
  const data: LocalData = { engine, calendars: [], pendingInvites: null, calendarRev: 0, notesRev: 0, tasksRev: 0, listeners: new Set() }
  void refreshCalendars(data)
  void refreshInvites(data)
  return data
}

const notify = (data: LocalData) => {
  for (const listener of data.listeners) listener()
}

export async function refreshCalendars(data: LocalData) {
  const rev = data.calendarRev
  const calendars = await data.engine.listCalendars()
  // A later change may have raced this answer; its own refresh will land.
  if (rev !== data.calendarRev) return
  data.calendars = calendars
  notify(data)
}

/**
 * Invites change with the calendar: an arriving invite is applied as an event. One that wasn't pending
 * before goes on the menu bar's recent list; the first load only fills the list.
 */
export async function refreshInvites(data: LocalData, now = Date.now()) {
  const rev = data.calendarRev
  const next = await data.engine.pendingInvites()
  if (rev !== data.calendarRev) return
  for (const invite of arrivedInvites(data.pendingInvites, next)) pushRecent(inviteRecent(invite, now))
  data.pendingInvites = next
  notify(data)
}

/** Handles the engine events this module owns; false for every other event. */
export function applyLocalEvent(data: LocalData, event: EngineEvent): boolean {
  if (event.type === 'calendarChanged') {
    data.calendarRev++
    notify(data)
    void refreshCalendars(data)
    void refreshInvites(data)
    return true
  }
  if (event.type === 'notesChanged') {
    data.notesRev++
    notify(data)
    return true
  }
  if (event.type === 'tasksChanged') {
    data.tasksRev++
    notify(data)
    return true
  }
  return false
}

const LocalDataContext = createContext<LocalData | null>(null)
export const LocalDataProvider = LocalDataContext.Provider

function useLocalData(): LocalData {
  const data = useContext(LocalDataContext)
  if (!data) throw new Error('Calendar, notes and tasks hooks need MailProvider')
  return data
}

function useSlice<T>(read: (data: LocalData) => T): T {
  const data = useLocalData()
  return useSyncExternalStore(
    (listener) => {
      data.listeners.add(listener)
      return () => void data.listeners.delete(listener)
    },
    () => read(data),
  )
}

/** Every calendar (for the sidebar, the editor's picker and colours); a new array only when they change. */
export const useCalendars = (): Calendar[] => useSlice((d) => d.calendars)
export const useCalendarRevision = (): number => useSlice((d) => d.calendarRev)
export const useNotesRevision = (): number => useSlice((d) => d.notesRev)
export const useTasksRevision = (): number => useSlice((d) => d.tasksRev)

/**
 * Recent answers by kind, revision and key, for queries that opt in: paging the calendar back to a
 * range (or to one fetched ahead) shows it in the same render instead of a render later. A new
 * revision makes every entry for the kind stale; old ones fall off the end.
 */
const answers = new WeakMap<LocalData, Map<string, unknown>>()
const ANSWERS_KEPT = 32
const answerId = (kind: string, rev: number, key: string) => `${kind}\u0000${rev}\u0000${key}`
function answersOf(data: LocalData) {
  let map = answers.get(data)
  if (!map) answers.set(data, (map = new Map()))
  return map
}
function remember(data: LocalData, id: string, value: unknown) {
  const map = answersOf(data)
  map.delete(id)
  map.set(id, value)
  if (map.size > ANSWERS_KEPT) map.delete(map.keys().next().value!)
}
const revOf = (data: LocalData, kind: 'calendar' | 'notes' | 'tasks') => (kind === 'calendar' ? data.calendarRev : kind === 'notes' ? data.notesRev : data.tasksRev)

/**
 * The result of `load`, fetched again whenever `kind`'s revision or `key` changes. Keeps showing the
 * previous result while the next one loads (no flash of empty), and null only before the first.
 * `key` identifies the query: pass what `load` depends on, joined into a string. With `cache`, an
 * answer already fetched for this key and revision (see prefetchLocalQuery) is used right away.
 */
export function useLocalQuery<T>(kind: 'calendar' | 'notes' | 'tasks', key: string, load: (engine: LocalData['engine']) => Promise<T>, options?: { cache?: boolean }): T | null {
  const data = useLocalData()
  const rev = useSlice((d) => revOf(d, kind))
  const cache = options?.cache ?? false
  const id = answerId(kind, rev, key)
  const cached = cache ? (answersOf(data).get(id) as T | undefined) : undefined
  const [value, setValue] = useState<{ id: string; value: T } | null>(null)
  // What was shown last, to keep showing while another key loads (and to reuse unchanged items from).
  const shown = useRef<T | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const hit = cached !== undefined
  useEffect(() => {
    if (hit) return
    let current = true
    // Items that didn't change keep their identity, so memoized rows skip a refetch after a save.
    void loadRef.current(data.engine).then((next) => {
      if (!current) return
      const kept = reuseUnchangedItems(shown.current, next)
      if (cache) remember(data, id, kept)
      setValue({ id, value: kept })
    })
    return () => {
      current = false
    }
  }, [data, rev, key, hit])
  const result = hit ? cached : value?.id === id ? value.value : (shown.current ?? value?.value ?? null)
  shown.current = result
  return result
}

/** Fetches a cached query's answer ahead of time (see useLocalQuery's `cache`), unless it's there. */
export function usePrefetchLocalQuery(): (kind: 'calendar' | 'notes' | 'tasks', key: string, load: (engine: LocalData['engine']) => Promise<unknown>) => void {
  const data = useLocalData()
  return useMemo(
    () => (kind, key, load) => {
      const rev = revOf(data, kind)
      const id = answerId(kind, rev, key)
      if (answersOf(data).has(id)) return
      // A placeholder would be read as an answer; just fetch, and keep it if nothing changed meanwhile.
      void load(data.engine).then((value) => {
        if (revOf(data, kind) === rev && !answersOf(data).has(id)) remember(data, id, value)
      }, () => {})
    },
    [data],
  )
}

const eventsKey = (from: number, to: number, calendarIds?: string[]) => `${from}:${to}:${calendarIds?.join(',') ?? '*'}`

/** Occurrences overlapping [from, to) in visible calendars, or the given ones. */
export const useEvents = (from: number, to: number, calendarIds?: string[]): EventOccurrence[] | null =>
  useLocalQuery('calendar', eventsKey(from, to, calendarIds), (e) => e.listEvents(from, to, calendarIds))

/**
 * useEvents for a calendar view's range: shown at once when it was fetched before or ahead (see
 * usePrefetchEvents), so paging to it is one render rather than one with the old week's events
 * and another with the new.
 */
export const useCachedEvents = (from: number, to: number): EventOccurrence[] | null =>
  useLocalQuery('calendar', eventsKey(from, to), (e) => e.listEvents(from, to), { cache: true })

/** Fetches ranges for useCachedEvents ahead of time (the weeks either side of the one on screen). */
export function usePrefetchEvents(): (ranges: Array<{ from: number; to: number }>) => void {
  const prefetch = usePrefetchLocalQuery()
  return useMemo(() => (ranges) => ranges.forEach(({ from, to }) => prefetch('calendar', eventsKey(from, to), (e) => e.listEvents(from, to))), [prefetch])
}

export const useNotes = (query = ''): Note[] | null => useLocalQuery('notes', query, (e) => e.listNotes(query || undefined))

/** Notes linked to a conversation; `accountId` is useMailActions().accountOf(threadId).id. */
export const useThreadNotes = (accountId: string, threadId: string): Note[] | null =>
  useLocalQuery('notes', `${accountId}\u0000${threadId}`, (e) => e.notesForThread(accountId, threadId))

export const useThreadEvents = (accountId: string, threadId: string): CalendarEvent[] | null =>
  useLocalQuery('calendar', `${accountId}\u0000${threadId}`, (e) => e.eventsForThread(accountId, threadId))

/**
 * Received invitations waiting for an answer, soonest first; empty before the first load. Refreshed
 * on every calendarChanged; ones over by `now` are left out (pass useNow() to drop them as time passes).
 */
export function usePendingInvites(now = Date.now()): InviteSummary[] {
  const all = useSlice((d) => d.pendingInvites)
  const minute = Math.floor(now / 60_000) * 60_000
  return useMemo(() => (all ?? []).filter((i) => i.endAt > minute), [all, minute])
}

export const useEventNotes =(eventId: string): Note[] | null => useLocalQuery('notes', eventId, (e) => e.notesForEvent(eventId))

/** Tasks for a list or search (open by default); refetched on every tasksChanged. */
export const useTasks = (query: TaskQuery = {}): Task[] | null =>
  useLocalQuery('tasks', JSON.stringify([query.status ?? 'open', query.projectId, query.labelId, query.search, query.limit]), (e) => e.listTasks(query))

export const useTaskProjects = (): TaskProject[] | null => useLocalQuery('tasks', 'projects', (e) => e.listTaskProjects())
export const useTaskLabels = (): TaskLabel[] | null => useLocalQuery('tasks', 'labels', (e) => e.listTaskLabels())

/** Tasks linked to a conversation, open ones first; `accountId` is useMailActions().accountOf(threadId).id. */
export const useThreadTasks = (accountId: string, threadId: string): Task[] | null =>
  useLocalQuery('tasks', `${accountId}\u0000${threadId}`, (e) => e.tasksForThread(accountId, threadId))
