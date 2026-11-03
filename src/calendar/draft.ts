import type { Attendee, CalendarEvent, EventInput, EventOccurrence, MailLinkTarget } from '../engine'
import { meetingLink } from '../engine/calendar/meeting'
import { DAY, HOUR, addDays, allDayToLocal, atMinutes, localToAllDay, minutesOfDay, startOfDay } from './dates'

// ---------------------------------------------------------------------------
// The event editor's model: what the form holds, how it's checked, and how it becomes the engine's
// EventInput. Pure, so validation and the conversions are tested without the UI.
// ---------------------------------------------------------------------------

/**
 * What another part of the app can hand the editor (openEventEditor). Times are epoch ms on the
 * person's clock. For an all-day prefill, `start` is any instant on the first day and `end` the
 * exclusive end (the local midnight after the last day), the way src/detect reports dates.
 */
export type EventPrefill = {
  title?: string
  start?: number
  end?: number
  allDay?: boolean
  location?: string
  /** A meeting link (Zoom, Meet, Teams…). */
  url?: string
  description?: string
  calendarId?: string
  /** Attendee addresses. */
  attendees?: string[]
  /** Mail the event comes from; linked as it's saved. */
  link?: MailLinkTarget
}

/** A prefill from an engine EventInput (what the reader's quick add builds): all-day dates become local days. */
export function prefillFromInput(input: EventInput): EventPrefill {
  const allDay = !!input.allDay
  return {
    title: input.title,
    start: allDay ? allDayToLocal(input.startAt) : input.startAt,
    end: allDay ? allDayToLocal(input.endAt) : input.endAt,
    allDay,
    location: input.location ?? undefined,
    url: input.url ?? undefined,
    description: input.description ?? undefined,
    calendarId: input.calendarId,
    attendees: input.attendees?.map((a) => a.email),
    link: input.links?.[0] ?? input.invite,
  }
}

export type EventDraft = {
  title: string
  allDay: boolean
  /** Local midnights of the first and last day (inclusive). */
  startDay: number
  endDay: number
  /** Minutes after midnight, for timed events. */
  startMinutes: number
  endMinutes: number
  location: string
  /** The meeting link as typed; stored as CalendarEvent.url. */
  url: string
  description: string
  calendarId: string
  /** RRULE text, or '' for none. */
  recurrence: string
  attendees: string[]
  /** Kept from the stored event so editing doesn't drop what the form doesn't show. */
  attendeeDetails: Attendee[]
  /** CalendarEvent.alarms: null follows the default in Settings, [] is none. */
  alarms: number[] | null
  link?: MailLinkTarget
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Guests after adding what was typed: addresses split on commas, semicolons and spaces, each put
 * through `resolve` (a contact's name to their address), and none added twice.
 */
export function addGuests(current: string[], typed: string, resolve: (part: string) => string | undefined = () => undefined): string[] {
  const next = [...current]
  for (const part of typed.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean)) {
    const email = resolve(part) ?? part
    if (!next.some((e) => e.toLowerCase() === email.toLowerCase())) next.push(email)
  }
  return next
}

/** The next half hour from `now`, for a new event with no time given. */
export const nextSlot = (now: number) => {
  const next = Math.ceil((now + 1) / (30 * 60_000)) * 30 * 60_000
  return next
}

export function draftFromPrefill(prefill: EventPrefill, defaults: { calendarId: string; now: number }): EventDraft {
  const allDay = !!prefill.allDay
  const start = prefill.start ?? nextSlot(defaults.now)
  let end = prefill.end ?? (allDay ? addDays(startOfDay(start), 1) : start + HOUR)
  if (end <= start) end = allDay ? addDays(startOfDay(start), 1) : start + HOUR
  return {
    title: prefill.title ?? '',
    allDay,
    startDay: startOfDay(start),
    // An exclusive all-day end is the midnight after the last day.
    endDay: allDay ? Math.max(startOfDay(start), startOfDay(end - 1)) : startOfDay(end),
    startMinutes: allDay ? 9 * 60 : minutesOfDay(start),
    endMinutes: allDay ? 10 * 60 : minutesOfDay(end),
    location: prefill.location ?? '',
    url: prefill.url ?? '',
    description: prefill.description ?? '',
    calendarId: prefill.calendarId ?? defaults.calendarId,
    recurrence: '',
    attendees: prefill.attendees ?? [],
    attendeeDetails: [],
    alarms: null,
    link: prefill.link,
  }
}

/** The form for an existing event, as the occurrence being edited shows it. */
export function draftFromEvent(event: CalendarEvent | EventOccurrence): EventDraft {
  const start = event.allDay ? allDayToLocal(event.startAt) : event.startAt
  const end = event.allDay ? Math.max(allDayToLocal(event.endAt), addDays(start, 1)) : event.endAt
  return {
    title: event.title,
    allDay: event.allDay,
    startDay: startOfDay(start),
    endDay: event.allDay ? startOfDay(end - 1) : startOfDay(end),
    startMinutes: event.allDay ? 9 * 60 : minutesOfDay(start),
    endMinutes: event.allDay ? 10 * 60 : minutesOfDay(end),
    location: event.location ?? '',
    url: event.url ?? '',
    description: event.description ?? '',
    calendarId: event.calendarId,
    recurrence: event.recurrence ?? '',
    attendees: event.attendees.map((a) => a.email),
    attendeeDetails: event.attendees,
    alarms: event.alarms,
  }
}

/** The instants the form describes: timed ones on the person's clock, all-day ones as local midnights. */
export function draftSpan(d: EventDraft): { start: number; end: number } {
  if (d.allDay) return { start: d.startDay, end: addDays(d.endDay, 1) }
  return { start: atMinutes(d.startDay, d.startMinutes), end: atMinutes(d.endDay, d.endMinutes) }
}

export type DraftErrors = Partial<Record<'title' | 'end' | 'url' | 'attendees', string>>

export function validateDraft(d: EventDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (d.title.length > 500) errors.title = 'That title is too long'
  const { start, end } = draftSpan(d)
  if (d.allDay ? d.endDay < d.startDay : end <= start) errors.end = 'The event has to end after it starts'
  else if (end - start > 366 * DAY) errors.end = 'An event can last a year at most'
  if (d.url.trim() && !meetingLink(d.url)) errors.url = 'That isn’t a link'
  const bad = d.attendees.filter((email) => !EMAIL_RE.test(email))
  if (bad.length) errors.attendees = bad.length === 1 ? `${bad[0]} isn’t an email address` : `${bad.length} addresses aren’t valid`
  return errors
}

export const hasErrors = (errors: DraftErrors) => Object.keys(errors).length > 0

/** The engine input for a draft; `id` updates that event. */
export function draftToInput(d: EventDraft, id?: string): EventInput {
  const { start, end } = draftSpan(d)
  const known = new Map(d.attendeeDetails.map((a) => [a.email.toLowerCase(), a]))
  return {
    ...(id ? { id } : {}),
    calendarId: d.calendarId,
    title: d.title.trim() || 'New event',
    allDay: d.allDay,
    startAt: d.allDay ? localToAllDay(start) : start,
    endAt: d.allDay ? localToAllDay(end) : end,
    location: d.location.trim() || null,
    url: meetingLink(d.url),
    description: d.description.trim() || null,
    recurrence: d.recurrence || null,
    alarms: d.alarms,
    attendees: d.attendees.map((email) => known.get(email.toLowerCase()) ?? { email, role: 'required', partstat: 'needs-action', rsvp: true }),
    ...(d.link && !id ? { links: [d.link] } : {}),
  }
}

/**
 * Whether saving should send invitations: the event has guests and it's the person's own. An
 * invitation they received lists them among its attendees (marked `self`); only its organizer can
 * send it, so editing it locally (a different alert, say) sends nothing.
 */
export const sendsInvites = (d: Pick<EventDraft, 'attendees' | 'attendeeDetails'>) => d.attendees.length > 0 && !d.attendeeDetails.some((a) => a.self)

/**
 * Keeps the length when the start moves, like every calendar: pushing a meeting an hour later
 * pushes its end too.
 */
export function moveStart(d: EventDraft, patch: { startDay?: number; startMinutes?: number }): EventDraft {
  const before = draftSpan(d)
  const next = { ...d, ...patch, recurrence: ruleForDay(d.recurrence, d.startDay, patch.startDay ?? d.startDay) }
  if (d.allDay) {
    const days = Math.round((d.endDay - d.startDay) / DAY)
    return { ...next, endDay: addDays(next.startDay, days) }
  }
  const start = atMinutes(next.startDay, next.startMinutes)
  const end = start + (before.end - before.start)
  return { ...next, endDay: startOfDay(end), endMinutes: minutesOfDay(end) }
}

/**
 * A weekly rule on the event's own weekday follows the event to another day: "every Tuesday" moved
 * to a Wednesday repeats on Wednesdays. Otherwise the rule would no longer include the day the
 * event now starts on, and that first occurrence would vanish. Rules on other or several weekdays
 * ("every weekday") are left as they are.
 */
export function ruleForDay(rule: string, fromDay: number, toDay: number): string
export function ruleForDay(rule: string | null, fromDay: number, toDay: number): string | null
export function ruleForDay(rule: string | null, fromDay: number, toDay: number): string | null {
  if (!rule) return rule
  const from = BYDAY[new Date(fromDay).getDay()]!
  const to = BYDAY[new Date(toDay).getDay()]!
  if (from === to) return rule
  const parts = rule.split(';')
  if (!parts.some((p) => p.toUpperCase() === 'FREQ=WEEKLY')) return rule
  const i = parts.findIndex((p) => p.toUpperCase().startsWith('BYDAY='))
  if (i < 0 || parts[i]!.slice(6).toUpperCase() !== from) return rule
  parts[i] = `BYDAY=${to}`
  return parts.join(';')
}

// --- Times as typed -----------------------------------------------------------

/**
 * Minutes after midnight for what someone typed into a time field: "9", "9:30", "930", "9pm",
 * "9.30 p.m.", "21:15", "noon", "midnight". Null when it isn't a time.
 */
export function parseTimeInput(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
  if (!t) return null
  if (t === 'noon' || t === 'midday') return 12 * 60
  if (t === 'midnight') return 0
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p|h)?$/.exec(t) ?? /^(\d{1,2})h(\d{2})$/.exec(t)
  if (!m) return null
  let hours = Number(m[1])
  const minutes = m[2] ? Number(m[2]) : 0
  const suffix = m[3]
  if (minutes > 59) return null
  if (suffix === 'am' || suffix === 'a' || suffix === 'pm' || suffix === 'p') {
    if (hours < 1 || hours > 12) return null
    if (hours === 12) hours = 0
    if (suffix.startsWith('p')) hours += 12
  } else if (hours > 23) return null
  return hours * 60 + minutes
}

// --- Repeat -------------------------------------------------------------------

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

export type RepeatOption = { rule: string; label: string }

/** The repeat choices the editor offers, worded for the event's first day. */
export function repeatOptions(startDay: number, locale?: string): RepeatOption[] {
  const d = new Date(startDay)
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d)
  const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(d)
  return [
    { rule: '', label: 'Does not repeat' },
    { rule: 'FREQ=DAILY', label: 'Every day' },
    { rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday' },
    { rule: `FREQ=WEEKLY;BYDAY=${BYDAY[d.getDay()]}`, label: `Every week on ${weekday}` },
    { rule: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${BYDAY[d.getDay()]}`, label: `Every other ${weekday}` },
    { rule: 'FREQ=MONTHLY', label: `Every month on the ${ordinal(d.getDate())}` },
    { rule: 'FREQ=YEARLY', label: `Every year on ${date}` },
  ]
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

/** A rule in words, for the detail card and a rule the presets don't cover. */
export function describeRule(rule: string | null, startDay: number, locale?: string): string {
  if (!rule) return 'Does not repeat'
  const preset = repeatOptions(startDay, locale).find((o) => o.rule === rule)
  if (preset) return preset.label
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=') as [string, string]))
  const every = Number(parts.INTERVAL ?? 1)
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[parts.FREQ as string] ?? 'time'
  let text = every > 1 ? `Every ${every} ${unit}s` : `Every ${unit}`
  if (parts.BYDAY) {
    const names = parts.BYDAY.split(',').map((code) => {
      const index = BYDAY.indexOf(code)
      return index < 0 ? code : new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2026, 0, 4 + index))
    })
    text += ` on ${names.join(', ')}`
  }
  if (parts.COUNT) text += `, ${parts.COUNT} times`
  else if (parts.UNTIL) {
    const u = parts.UNTIL
    // The rule's date as written: read in UTC, so a zone far from Greenwich doesn't make it the day before or after.
    text += `, until ${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8)))}`
  }
  return text
}
