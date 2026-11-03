import { offsetMinutes, wallTime } from '../../detect/tz'
import type { Attendee, Organizer, PartStat } from './types'

// ---------------------------------------------------------------------------
// A small RFC 5545 writer for the iTIP mail Jefi sends (RFC 5546 REQUEST / CANCEL / REPLY). Lines
// end in CRLF and fold at 75 octets without splitting a UTF-8 character; text values are escaped.
//
// Times: a one-off timed event goes out in UTC (`…Z`), which every client accepts and which can't be
// misread. A recurring one goes out with TZID and a VTIMEZONE, because in UTC a 09:00 weekly meeting
// would slide an hour for everyone at the next DST change. All-day events are VALUE=DATE.
// ---------------------------------------------------------------------------

export const PRODID = '-//Jefi//Jefi Mail//EN'

export type IcsMethod = 'REQUEST' | 'CANCEL' | 'REPLY'

export type VEventOut = {
  uid: string
  sequence: number
  /** Defaults to now. */
  dtstamp?: number
  title: string
  startAt: number
  endAt: number
  allDay: boolean
  timeZone: string | null
  location?: string | null
  description?: string | null
  url?: string | null
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
  organizer?: Organizer | null
  attendees?: Attendee[]
  recurrence?: string | null
  exdates?: number[]
  recurrenceId?: number | null
  comment?: string
  /** Display alerts, minutes before the start (see CalendarEvent.alarms). */
  alarms?: number[]
}

export const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')

// A parameter value can't hold a DQUOTE at all; quote it when it has : ; or ,.
const paramValue = (s: string) => {
  const v = s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')
  return /[:;,]/.test(v) ? `"${v}"` : v
}

/** Folds one content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 sequence. */
export function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const out: string[] = []
  let chunk = ''
  let size = 0
  let limit = 75
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length
    if (size + n > limit) {
      out.push(chunk)
      chunk = ''
      size = 0
      // Continuation lines start with a space, which counts toward their 75.
      limit = 74
    }
    chunk += ch
    size += n
  }
  out.push(chunk)
  return out.join('\r\n ')
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
export const utcStamp = (t: number) => {
  const d = new Date(t)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}
const dateValue = (t: number) => {
  const d = new Date(t)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}
const localValue = (t: number, zone: string) => {
  const w = wallTime(t, zone)
  return `${w.year}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`
}

/** How the event's times are written: dates, UTC instants, or wall times in its zone. */
type TimeForm = { kind: 'date' } | { kind: 'utc' } | { kind: 'zone'; zone: string }

const timeForm = (e: VEventOut): TimeForm => {
  if (e.allDay) return { kind: 'date' }
  const zone = e.timeZone
  if (zone && zone !== 'UTC' && zone !== 'Etc/UTC' && (e.recurrence || e.recurrenceId != null)) return { kind: 'zone', zone }
  return { kind: 'utc' }
}

const timeProp = (name: string, t: number, form: TimeForm) =>
  form.kind === 'date' ? `${name};VALUE=DATE:${dateValue(t)}` : form.kind === 'zone' ? `${name};TZID=${form.zone}:${localValue(t, form.zone)}` : `${name}:${utcStamp(t)}`

const timeList = (name: string, times: number[], form: TimeForm) =>
  form.kind === 'date'
    ? `${name};VALUE=DATE:${times.map(dateValue).join(',')}`
    : form.kind === 'zone'
      ? `${name};TZID=${form.zone}:${times.map((t) => localValue(t, form.zone)).join(',')}`
      : `${name}:${times.map(utcStamp).join(',')}`

/** RFC 5545 wants UNTIL in UTC when DTSTART has a zone, and a DATE for all-day events. */
function rruleOut(rule: string, form: TimeForm) {
  return rule.replace(/UNTIL=(\d{8})(T(\d{2})(\d{2})(\d{2})(Z)?)?/, (whole, date: string, time?: string, h?: string, m?: string, s?: string, z?: string) => {
    if (form.kind === 'date') return `UNTIL=${date}`
    if (!time) return `UNTIL=${date}T235959Z`
    if (z || form.kind !== 'zone') return whole.endsWith('Z') ? whole : `${whole}Z`
    const wall = { year: +date.slice(0, 4), month: +date.slice(4, 6), day: +date.slice(6, 8), hour: +h!, minute: +m!, second: +s! }
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
    return `UNTIL=${utcStamp(asUtc - offsetMinutes(asUtc, form.zone) * 60000)}`
  })
}

const PARTSTAT: Record<PartStat, string> = {
  'needs-action': 'NEEDS-ACTION',
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  delegated: 'DELEGATED',
}
const ROLE = { required: 'REQ-PARTICIPANT', optional: 'OPT-PARTICIPANT', chair: 'CHAIR', 'non-participant': 'NON-PARTICIPANT' } as const

const mailto = (email: string) => `mailto:${email}`

export function attendeeLine(a: Attendee) {
  const params = [
    `CUTYPE=INDIVIDUAL`,
    `ROLE=${ROLE[a.role ?? 'required']}`,
    `PARTSTAT=${PARTSTAT[a.partstat ?? 'needs-action']}`,
    ...(a.rsvp ? ['RSVP=TRUE'] : []),
    ...(a.name ? [`CN=${paramValue(a.name)}`] : []),
  ]
  return `ATTENDEE;${params.join(';')}:${mailto(a.email)}`
}

const organizerLine = (o: Organizer) => `ORGANIZER${o.name ? `;CN=${paramValue(o.name)}` : ''}:${mailto(o.email)}`

function eventLines(e: VEventOut): string[] {
  const form = timeForm(e)
  const lines = ['BEGIN:VEVENT', `UID:${e.uid}`, `SEQUENCE:${e.sequence}`, `DTSTAMP:${utcStamp(e.dtstamp ?? Date.now())}`]
  lines.push(timeProp('DTSTART', e.startAt, form), timeProp('DTEND', e.endAt, form))
  if (e.recurrenceId != null) lines.push(timeProp('RECURRENCE-ID', e.recurrenceId, form))
  if (e.recurrence) lines.push(`RRULE:${rruleOut(e.recurrence, form)}`)
  if (e.recurrence && e.exdates?.length) lines.push(timeList('EXDATE', e.exdates, form))
  lines.push(`SUMMARY:${escapeText(e.title)}`)
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`)
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`)
  if (e.url) lines.push(`URL:${e.url}`)
  if (e.status) lines.push(`STATUS:${e.status}`)
  if (e.organizer) lines.push(organizerLine(e.organizer))
  for (const a of e.attendees ?? []) lines.push(attendeeLine(a))
  if (e.comment) lines.push(`COMMENT:${escapeText(e.comment)}`)
  lines.push('TRANSP:OPAQUE')
  for (const minutes of e.alarms ?? []) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.title)}`, `TRIGGER:${triggerValue(minutes)}`, 'END:VALARM')
  lines.push('END:VEVENT')
  return lines
}

/** RFC 5545 duration for an alert `minutes` before the start: -PT10M, PT0S, -P1D, PT9H (after). */
export function triggerValue(minutes: number) {
  if (minutes === 0) return 'PT0S'
  const sign = minutes > 0 ? '-' : ''
  const m = Math.abs(minutes)
  if (m % 1440 === 0) return `${sign}P${m / 1440}D`
  const h = Math.floor(m / 60)
  return `${sign}PT${h ? `${h}H` : ''}${m % 60 ? `${m % 60}M` : ''}`
}

// --- VTIMEZONE ----------------------------------------------------------------------------------

const offsetText = (minutes: number) => {
  const a = Math.abs(minutes)
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(a % 60)}`
}
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** The instants in `year` where the zone's offset changes, to the minute. */
function transitions(zone: string, year: number) {
  const found: Array<{ at: number; from: number; to: number }> = []
  const DAY = 86_400_000
  let t = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  let prev = offsetMinutes(t, zone)
  for (; t < end; t += DAY) {
    const next = offsetMinutes(t + DAY, zone)
    if (next === prev) continue
    let lo = t
    let hi = t + DAY
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000
      if (offsetMinutes(mid, zone) === prev) lo = mid
      else hi = mid
    }
    found.push({ at: hi, from: prev, to: next })
    prev = next
  }
  return found
}

/**
 * A VTIMEZONE for `zone` built from Intl: yearly STANDARD/DAYLIGHT rules taken from the transitions
 * in `year` (nth or last weekday of the month, which is how every DST rule in use is written), or
 * one fixed offset for a zone without DST.
 */
export function vtimezone(zone: string, year: number): string[] {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`, `X-LIC-LOCATION:${zone}`]
  const found = transitions(zone, year)
  if (!found.length) {
    const off = offsetText(offsetMinutes(Date.UTC(year, 0, 1), zone))
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'DTSTART:19700101T000000', 'END:STANDARD')
  } else {
    for (const tr of found) {
      // The transition as a wall time on the clock before it.
      const local = new Date(tr.at + tr.from * 60000)
      const month = local.getUTCMonth() + 1
      const day = local.getUTCDate()
      const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate()
      const nth = day + 7 > daysInMonth ? -1 : Math.floor((day - 1) / 7) + 1
      const kind = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD'
      lines.push(
        `BEGIN:${kind}`,
        `TZOFFSETFROM:${offsetText(tr.from)}`,
        `TZOFFSETTO:${offsetText(tr.to)}`,
        `DTSTART:1970${pad(month)}${pad(day)}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${DAYS[local.getUTCDay()]}`,
        `END:${kind}`,
      )
    }
  }
  lines.push('END:VTIMEZONE')
  return lines
}

// --- Calendar ------------------------------------------------------------------------------------

/** A whole VCALENDAR: METHOD, the VTIMEZONEs its events need, then the events. CRLF throughout. */
export function writeCalendar(method: IcsMethod, events: VEventOut[]): string {
  const zones = new Map<string, number>()
  for (const e of events) {
    const form = timeForm(e)
    if (form.kind === 'zone' && !zones.has(form.zone)) zones.set(form.zone, new Date(e.startAt).getUTCFullYear())
  }
  const lines = ['BEGIN:VCALENDAR', `PRODID:${PRODID}`, 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${method}`]
  for (const [zone, year] of zones) lines.push(...vtimezone(zone, year))
  for (const e of events) lines.push(...eventLines(e))
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
