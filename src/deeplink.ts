import type { CalendarView } from './calendar/state'
import type { EventPrefill } from './calendar/draft'
import { addDays } from './calendar/dates'

// ---------------------------------------------------------------------------
// jefi:// links (docs/integrations.md §1). Any app on the Mac can open one, so a link is untrusted
// input: it is parsed into a closed set of routes with capped, validated values, and it only ever
// navigates or prefills. Nothing here sends, saves or deletes; the person does that.
// ---------------------------------------------------------------------------

/** The parts of Settings a link can open (jefi://settings/<section>); settings-pages.ts says which page shows each. */
export const SETTINGS_SECTIONS = ['appearance', 'mailbox', 'privacy', 'accounts', 'ai', 'signin', 'calendar', 'tasks', 'sync', 'menubar', 'integrations', 'keyboard', 'cleanup', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const CALENDAR_VIEWS: readonly CalendarView[] = ['day', 'week', 'month', 'agenda']

export type ComposePrefill = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; account?: string }
export type NewEventPrefill = { title?: string; start?: string; end?: string; allDay?: boolean; location?: string; notes?: string }

export type JefiRoute =
  /** A jefi:// link whose route isn't known (or whose required part is missing): just open Jefi. */
  | { kind: 'open' }
  | { kind: 'inbox'; accountId?: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'compose'; prefill: ComposePrefill }
  | { kind: 'search'; query: string }
  | { kind: 'calendar'; date?: string; view?: CalendarView }
  | { kind: 'event'; eventId: string; start?: number }
  | { kind: 'new-event'; prefill: NewEventPrefill }
  | { kind: 'quick-add'; text: string }
  | { kind: 'notes'; noteId?: string }
  | { kind: 'new-note'; title: string; body: string }
  | { kind: 'settings'; section?: SettingsSection }

export const MAX_URL = 8192
const MAX_ID = 512
const MAX_LINE = 1000
const MAX_TEXT = 20_000
const MAX_RECIPIENTS = 100

/** One line of text: control characters and line breaks become spaces, capped. */
const line = (value: string | null, max = MAX_LINE) => (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
/** A block of text: keeps line breaks and tabs, drops other control characters, capped. */
const text = (value: string | null, max = MAX_TEXT) => (value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max)

/** An id from the path: one segment, printable, bounded. */
function id(value: string | undefined) {
  if (!value) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return undefined
  }
  return decoded.length <= MAX_ID && !/[\u0000-\u001f\u007f/]/.test(decoded) ? decoded : undefined
}

const ADDRESS = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/

/** Comma-separated addresses; `Name <a@b.c>` keeps the address. Anything else is dropped. */
export function recipients(value: string | null): string[] {
  const out: string[] = []
  for (const part of (value ?? '').split(/[,;]/)) {
    const address = (part.match(/<([^>]*)>/)?.[1] ?? part).trim()
    if (address.length <= 320 && ADDRESS.test(address) && !out.includes(address)) out.push(address)
    if (out.length >= MAX_RECIPIENTS) break
  }
  return out
}

/** A real calendar day as YYYY-MM-DD, or undefined. */
export function isoDay(value: string | null) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value! : undefined
}

/** An ISO 8601 day or date-time (offset optional), or undefined. */
export function isoInstant(value: string | null) {
  if (!value) return undefined
  if (isoDay(value)) return value
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/)
  return match && isoDay(match[1]!) && Number.isFinite(Date.parse(value)) ? value : undefined
}

/** Epoch ms as the notification routes carry it: a non-negative integer. */
const epochMs = (value: string | null) => (value && /^\d{1,15}$/.test(value) ? Number(value) : undefined)

/** Drops undefined keys so routes compare cleanly. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** The route a jefi:// link asks for; null for anything that isn't a well-formed jefi:// URL. */
export function parseJefiUrl(url: string): JefiRoute | null {
  if (typeof url !== 'string' || url.length > MAX_URL || !/^jefi:/i.test(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'jefi:') return null
  // jefi://thread/x has host "thread"; jefi:thread/x (no slashes) has it in the path.
  const segments = `${parsed.host}${parsed.pathname}`.split('/').filter((s, i) => s || i === 0)
  const [head = '', ...rest] = segments
  const route = head.toLowerCase()
  const q = parsed.searchParams
  const target = id(rest[0])
  switch (route) {
    case '':
    case 'inbox':
      return target ? { kind: 'inbox', accountId: target } : { kind: 'inbox' }
    case 'thread':
      return target ? { kind: 'thread', threadId: target } : { kind: 'open' }
    case 'compose': {
      const account = line(q.get('account'), 320)
      return {
        kind: 'compose',
        prefill: defined({ to: recipients(q.get('to')), cc: recipients(q.get('cc')), bcc: recipients(q.get('bcc')), subject: line(q.get('subject')), body: text(q.get('body')), account: account || undefined }),
      }
    }
    case 'search':
      return { kind: 'search', query: line(q.get('q'), 500) }
    case 'calendar': {
      const view = q.get('view')?.toLowerCase() as CalendarView | undefined
      return defined({ kind: 'calendar' as const, date: isoDay(q.get('date')), view: view && CALENDAR_VIEWS.includes(view) ? view : undefined })
    }
    case 'event':
      return target ? defined({ kind: 'event' as const, eventId: target, start: epochMs(q.get('start')) }) : { kind: 'open' }
    case 'new-event': {
      const allDay = q.get('allDay')
      return {
        kind: 'new-event',
        prefill: defined({
          title: line(q.get('title'), 500) || undefined,
          start: isoInstant(q.get('start')),
          end: isoInstant(q.get('end')),
          allDay: allDay === '1' || allDay === 'true' ? true : undefined,
          location: line(q.get('location'), 500) || undefined,
          notes: text(q.get('notes'), 10_000) || undefined,
        }),
      }
    }
    case 'quick-add':
      return { kind: 'quick-add', text: line(q.get('text'), 500) }
    case 'notes':
      return { kind: 'notes' }
    case 'note':
      return target ? { kind: 'notes', noteId: target } : { kind: 'notes' }
    case 'new-note':
      return { kind: 'new-note', title: line(q.get('title'), 500), body: text(q.get('body')) }
    case 'settings': {
      const section = rest[0]?.toLowerCase() as SettingsSection | undefined
      return section && SETTINGS_SECTIONS.includes(section) ? { kind: 'settings', section } : { kind: 'settings' }
    }
    default:
      return { kind: 'open' }
  }
}

// --- Dates --------------------------------------------------------------------------------------

/** Local midnight of a YYYY-MM-DD day. */
export function localDay(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year!, month! - 1, date!).getTime()
}

/** A day (local midnight) or a date-time; one without an offset is the person's local time, as JS reads it. */
const instant = (value: string) => (isoDay(value) ? localDay(value) : Date.parse(value))

/** The event editor's prefill for jefi://new-event. An all-day end is the last day, made exclusive here. */
export function eventPrefill(prefill: NewEventPrefill): EventPrefill {
  const start = prefill.start ? instant(prefill.start) : undefined
  let end = prefill.end ? instant(prefill.end) : undefined
  if (prefill.allDay && end !== undefined && prefill.end && isoDay(prefill.end)) end = addDays(end, 1)
  if (start !== undefined && end !== undefined && end <= start) end = undefined
  return defined({ title: prefill.title, start, end, allDay: prefill.allDay, location: prefill.location, description: prefill.notes })
}

// --- Routing ------------------------------------------------------------------------------------

/** What the app does for each route; the workspace supplies these (see useJefiLinks). */
export type LinkTargets = {
  showWindow: () => void
  inbox: (accountId?: string) => void
  thread: (threadId: string) => void
  compose: (prefill: ComposePrefill) => void
  search: (query: string) => void
  calendar: (request: { date?: number; view?: CalendarView }) => void
  event: (eventId: string, start?: number) => void
  editEvent: (prefill: EventPrefill) => void
  quickAdd: (text: string) => void
  notes: (noteId?: string) => void
  newNote: (prefill: { title: string; body: string }) => void
  settings: (section?: SettingsSection) => void
}

/** Brings Jefi forward, then does what the route asks. A null route (junk) only brings Jefi forward. */
export function routeJefiLink(route: JefiRoute | null, targets: LinkTargets) {
  targets.showWindow()
  if (!route) return
  switch (route.kind) {
    case 'open':
      return
    case 'inbox':
      return targets.inbox(route.accountId)
    case 'thread':
      return targets.thread(route.threadId)
    case 'compose':
      return targets.compose(route.prefill)
    case 'search':
      return targets.search(route.query)
    case 'calendar':
      return targets.calendar(defined({ date: route.date ? localDay(route.date) : undefined, view: route.view }))
    case 'event':
      return targets.event(route.eventId, route.start)
    case 'new-event':
      return targets.editEvent(eventPrefill(route.prefill))
    case 'quick-add':
      return targets.quickAdd(route.text)
    case 'notes':
      return targets.notes(route.noteId)
    case 'new-note':
      return targets.newNote({ title: route.title, body: route.body })
    case 'settings':
      return targets.settings(route.section)
  }
}

// --- Delivery -----------------------------------------------------------------------------------
// Links arrive from the native handler (src/native/links.ts) whenever AppKit delivers them, which on
// a cold launch is before the workspace exists. They wait here until a router subscribes.

type LinkListener = (route: JefiRoute | null) => void
const linkListeners = new Set<LinkListener>()
let pendingLinks: Array<JefiRoute | null> = []

/** Parses and routes a link, or keeps it until the app can. */
export function dispatchJefiUrl(url: string) {
  deliver(parseJefiUrl(url))
}

function deliver(route: JefiRoute | null) {
  if (!linkListeners.size) pendingLinks.push(route)
  else for (const listener of linkListeners) listener(route)
}

/** Keeps a route for whoever subscribes next: a link for another account waits for its workspace. */
export function deferJefiRoute(route: JefiRoute) {
  pendingLinks.push(route)
}

export function subscribeJefiLinks(listener: LinkListener) {
  linkListeners.add(listener)
  if (pendingLinks.length) {
    const queued = pendingLinks
    pendingLinks = []
    queueMicrotask(() => {
      for (const route of queued) if (linkListeners.has(listener)) listener(route)
    })
  }
  return () => void linkListeners.delete(listener)
}
