// What the reader offers to put in the calendar or in notes for a message. Pure: the components in
// this folder feed it the message, and tests check the choices without a UI.

import { detectDates, type DateSuggestion } from '../detect/dates'
import { wallTime, zonedToEpoch } from '../detect/tz'
import type { Message, MailThread } from '../data'
import type { CalendarEvent, EventInput, EventLink, MailLinkTarget } from '../engine'
import { splitQuoted } from '../mail-text'
import { messageText } from '../reply'

const DAY = 86_400_000

/** Mail older than this rarely holds a plan worth adding; its dates have mostly passed anyway. */
export const SUGGESTION_MAX_AGE_DAYS = 60
/** A strip, not a list: past three the suggestions stop being useful and start being noise. */
export const MAX_SHOWN = 3
/** Enough for any real letter; a giant newsletter isn't worth parsing to the end. */
const MAX_TEXT = 20_000

export const userTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

// Detection is cheap but not free, and the reader re-mounts a message's header as it scrolls.
const cache = new Map<string, DateSuggestion[]>()

const keyOf = (message: Message, timeZone: string) => {
  const sentAt = message.timestamp
  if (sentAt === undefined || !Number.isFinite(sentAt) || message.bodyMissing) return null
  const text = messageText(message).slice(0, MAX_TEXT)
  return { sentAt, text, key: `${message.id}\u0000${sentAt}\u0000${timeZone}\u0000${text.length}` }
}

/** Every date in the message that reads like an event, memoized per message body. */
export function detectForMessage(message: Message, subject: string, timeZone = userTimeZone()): DateSuggestion[] {
  const k = keyOf(message, timeZone)
  if (!k) return []
  const hit = cache.get(k.key)
  if (hit) return hit
  const found = detectDates({ text: k.text, subject, sentAt: k.sentAt, timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale })
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  cache.set(k.key, found)
  return found
}

/** The memoized answer when there is one, so a re-mounted header draws it without waiting. */
export function cachedSuggestions(message: Message, timeZone = userTimeZone()): DateSuggestion[] | undefined {
  const k = keyOf(message, timeZone)
  return k ? cache.get(k.key) : []
}

export type SuggestionContext = {
  message: Pick<Message, 'timestamp' | 'unsubscribe' | 'status'>
  detected: DateSuggestion[]
  now: number
  /** The message carries a calendar invite; its card covers the dates. */
  hasInvite: boolean
  /** The person dismissed suggestions for this message. */
  dismissed: boolean
}

/** Which detected dates the strip shows: few, current, and only on mail where they make sense. */
export function pickSuggestions({ message, detected, now, hasInvite, dismissed }: SuggestionContext): DateSuggestion[] {
  if (hasInvite || dismissed || message.status) return []
  const sentAt = message.timestamp
  if (sentAt === undefined || now - sentAt > SUGGESTION_MAX_AGE_DAYS * DAY) return []
  // Newsletters and promotions are full of dates nobody means to attend; only a clear one gets through.
  const bulk = Boolean(message.unsubscribe)
  return detected
    .filter((s) => (bulk ? s.confidence === 'high' && !s.allDay : true))
    .filter((s) => (s.end ?? s.start) > now)
    .slice(0, MAX_SHOWN)
}

/** Stable per suggestion, for list keys and test ids. */
export const suggestionKey = (s: Pick<DateSuggestion, 'start' | 'end' | 'allDay'>) => `${s.allDay ? 'd' : 't'}${s.start}-${s.end ?? ''}`

const sameDay = (a: number, b: number, timeZone: string) => {
  const x = wallTime(a, timeZone)
  const y = wallTime(b, timeZone)
  return x.year === y.year && x.month === y.month && x.day === y.day
}

/** "Fri 3 Oct, 15:00–16:00", "Fri 3 Oct", "Fri 3 – Sun 5 Oct" in the person's zone and locale. */
export function formatWhen(s: { start: number; end?: number; allDay: boolean }, timeZone = userTimeZone(), locale?: string) {
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone })
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone })
  if (s.allDay) {
    // The end is exclusive: the last day is the one before it.
    const last = s.end !== undefined ? s.end - DAY / 2 : s.start
    return sameDay(s.start, last, timeZone) ? day.format(s.start) : `${day.format(s.start)} – ${day.format(last)}`
  }
  if (s.end === undefined) return `${day.format(s.start)}, ${time.format(s.start)}`
  if (sameDay(s.start, s.end, timeZone)) return `${day.format(s.start)}, ${time.format(s.start)}–${time.format(s.end)}`
  return `${day.format(s.start)}, ${time.format(s.start)} – ${day.format(s.end)}, ${time.format(s.end)}`
}

/** A detected all-day range (zoned midnights) as the calendar stores it: whole UTC days. */
export function utcDays(start: number, end: number | undefined, timeZone: string) {
  const a = wallTime(start, timeZone)
  const from = Date.UTC(a.year, a.month - 1, a.day)
  if (end === undefined) return { startAt: from, endAt: from + DAY }
  const b = wallTime(end - 1, timeZone)
  return { startAt: from, endAt: Math.max(from + DAY, Date.UTC(b.year, b.month - 1, b.day) + DAY) }
}

/** The quick-add form's state: what the person sees and edits. Times are wall clock in `timeZone`. */
export type QuickAddDraft = {
  title: string
  /** YYYY-MM-DD. */
  date: string
  /** YYYY-MM-DD; the last day, inclusive, for all-day ranges. */
  endDate: string
  /** HH:MM, 24-hour. */
  startTime: string
  endTime: string
  allDay: boolean
  calendarId: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (w: { year: number; month: number; day: number }) => `${w.year}-${pad(w.month)}-${pad(w.day)}`
const hm = (w: { hour: number; minute: number }) => `${pad(w.hour)}:${pad(w.minute)}`

export function draftFromSuggestion(s: DateSuggestion, fallbackTitle: string, timeZone = userTimeZone()): QuickAddDraft {
  const start = wallTime(s.start, timeZone)
  const endAt = s.end ?? s.start + 3_600_000
  const end = wallTime(s.allDay ? endAt - 1 : endAt, timeZone)
  return {
    title: s.title ?? fallbackTitle,
    date: ymd(start),
    endDate: ymd(end),
    startTime: hm(start),
    endTime: hm(end),
    allDay: s.allDay,
    calendarId: null,
  }
}

const parseDate = (text: string) => {
  const m = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!m) return null
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null
}

const parseTime = (text: string) => {
  const m = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const half = m[3]?.toLowerCase()
  if (half) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (half === 'pm' ? 12 : 0)
  }
  return hour < 24 && minute < 60 ? { hour, minute } : null
}

/**
 * The event the quick-add form describes, linked to the message it came from, or the reason it
 * can't be saved yet (shown under the form).
 */
export function eventFromDraft(draft: QuickAddDraft, link: MailLinkTarget, timeZone = userTimeZone()): { ok: true; input: EventInput } | { ok: false; error: string } {
  const title = draft.title.trim()
  if (!title) return { ok: false, error: 'Give the event a title' }
  const day = parseDate(draft.date)
  if (!day) return { ok: false, error: 'Use a date like 2026-10-03' }
  const base = { title, calendarId: draft.calendarId ?? undefined, links: [link] }
  if (draft.allDay) {
    const last = draft.endDate.trim() ? parseDate(draft.endDate) : day
    if (!last) return { ok: false, error: 'Use an end date like 2026-10-05' }
    const startAt = Date.UTC(day.year, day.month - 1, day.day)
    const endAt = Date.UTC(last.year, last.month - 1, last.day) + DAY
    if (endAt <= startAt) return { ok: false, error: 'The event can’t end before it starts' }
    return { ok: true, input: { ...base, startAt, endAt, allDay: true } }
  }
  const from = parseTime(draft.startTime)
  const to = parseTime(draft.endTime)
  if (!from || !to) return { ok: false, error: 'Use times like 15:00' }
  const startAt = zonedToEpoch({ ...day, ...from, second: 0 }, timeZone)
  let endAt = zonedToEpoch({ ...day, ...to, second: 0 }, timeZone)
  // "23:00–01:00" runs past midnight.
  if (endAt <= startAt) endAt += DAY
  return { ok: true, input: { ...base, startAt, endAt, allDay: false, timeZone } }
}

/** Events linked to this exact message (made from it, or its invite). */
export function eventsForMessage(events: Array<{ event: CalendarEvent; links: EventLink[] }>, messageId: string): CalendarEvent[] {
  const points = (l: EventLink) => l.target.kind === 'message' && 'messageId' in l.target && l.target.messageId === messageId
  return events.filter(({ event, links }) => event.status !== 'cancelled' && (links.some(points) || (event.invite ? points(event.invite) : false))).map((e) => e.event)
}

// --- Notes ---------------------------------------------------------------------

const EXCERPT = 600

export function cleanSubject(subject: string) {
  let s = subject.trim()
  for (;;) {
    const next = s.replace(/^(?:re|fwd?|aw|wg|tr|sv)\s*:\s*/i, '').trim()
    if (next === s) break
    s = next
  }
  return s || 'Untitled email'
}

/** The first few lines the sender wrote (quoted history left out), as a markdown quote. */
export function excerpt(message: Message) {
  const body = splitQuoted(messageText(message)).body.trim()
  let text = body.length > EXCERPT ? `${body.slice(0, EXCERPT).replace(/\s+\S*$/, '')}…` : body
  if (!text) text = '(no text)'
  return text.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')
}

/** Who and when, above the excerpt. The note's link to the mail is the engine's, not text. */
export function excerptBlock(thread: Pick<MailThread, 'subject'>, message: Message, locale?: string) {
  const when = message.timestamp !== undefined ? new Date(message.timestamp).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : message.time
  return `**${message.from}** · ${when} · _${cleanSubject(thread.subject)}_\n\n${excerpt(message)}`
}

export const newNoteFromMessage = (thread: Pick<MailThread, 'subject'>, message: Message, locale?: string) => ({
  title: cleanSubject(thread.subject),
  body: excerptBlock(thread, message, locale),
})

/** An existing note's body with this message's excerpt added at the end. */
export const appendToBody = (body: string, thread: Pick<MailThread, 'subject'>, message: Message, locale?: string) =>
  `${body.trimEnd()}${body.trim() ? '\n\n---\n\n' : ''}${excerptBlock(thread, message, locale)}`
