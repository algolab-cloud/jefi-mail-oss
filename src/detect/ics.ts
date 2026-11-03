// A small RFC 5545 reader for the invites that arrive by mail. It only reads
// what a reader pane needs (VEVENT basics plus enough VTIMEZONE to place a
// time), so a hand parser stays short and avoids an MPL dependency.

import { isValidTimeZone, zonedToEpoch, type Wall } from './tz'

export type IcsPerson = { name?: string; email: string }
export type IcsAttendee = IcsPerson & { partstat?: string; role?: string; rsvp?: boolean }

export type IcsEvent = {
  uid: string
  sequence?: number
  summary: string
  description?: string
  location?: string
  start: number
  end?: number
  allDay: boolean
  // For all-day events the calendar date itself (YYYY-MM-DD, end exclusive),
  // since the epoch values depend on which zone midnight is taken in.
  startDate?: string
  endDate?: string
  // IANA zone the start was given in, when it had one.
  timeZone?: string
  rrule?: string
  status?: string
  organizer?: IcsPerson
  attendees: IcsAttendee[]
  url?: string
  // The original start of the occurrence this VEVENT overrides (RECURRENCE-ID).
  // All-day values are UTC midnights, like the calendar store keeps them.
  recurrenceId?: number
  // Removed occurrence starts (EXDATE), with the same all-day convention.
  exdates?: number[]
  comment?: string
  // Display and sound alerts (VALARM), as minutes before the start; negative is after it.
  alarms?: number[]
}

export type IcsCalendar = { method?: 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH' | (string & {}); events: IcsEvent[] }

export type IcsOptions = {
  // Zone for floating times and all-day midnights; the user's zone. Default UTC.
  timeZone?: string
}

type Prop = { name: string; params: Record<string, string>; value: string }
type Component = { type: string; props: Prop[]; children: Component[] }

// Windows zone names Exchange/Outlook put in TZID, mapped to IANA (from the
// CLDR windowsZones table, "001" territory). Only the frequent ones.
const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Pacific SA Standard Time': 'America/Santiago',
  'UTC': 'Etc/UTC',
  'Coordinated Universal Time': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Arab Standard Time': 'Asia/Riyadh',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Arabian Standard Time': 'Asia/Dubai',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
}

export function windowsToIana(name: string) {
  return WINDOWS_ZONES[name]
}

function unescapeText(s: string) {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

// Splits `NAME;P1=a;P2="b;c":value`, honouring quoted parameter values.
function parseLine(line: string): Prop | null {
  let i = 0
  let inQuote = false
  let nameEnd = -1
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (!inQuote && c === ';' && nameEnd < 0) nameEnd = i
    else if (!inQuote && c === ':') break
  }
  if (i >= line.length) return null
  const head = line.slice(0, i)
  const value = line.slice(i + 1)
  const name = (nameEnd < 0 ? head : head.slice(0, nameEnd)).trim().toUpperCase()
  if (!/^[A-Z0-9-]+$/.test(name)) return null
  const params: Record<string, string> = {}
  if (nameEnd >= 0) {
    const re = /;([A-Za-z0-9-]+)=("[^"]*"|[^;]*)/g
    let m: RegExpExecArray | null
    const rest = head.slice(nameEnd)
    while ((m = re.exec(rest))) params[m[1]!.toUpperCase()] = m[2]!.replace(/^"|"$/g, '')
  }
  return { name, params, value }
}

function parseComponents(text: string): Component[] {
  const unfolded = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '')
  const root: Component = { type: 'ROOT', props: [], children: [] }
  const stack = [root]
  for (const raw of unfolded.split('\n')) {
    if (!raw.trim()) continue
    const prop = parseLine(raw)
    if (!prop) continue
    const top = stack[stack.length - 1]!
    if (prop.name === 'BEGIN') {
      const c: Component = { type: prop.value.trim().toUpperCase(), props: [], children: [] }
      top.children.push(c)
      stack.push(c)
    } else if (prop.name === 'END') {
      // Pop to the matching BEGIN; tolerate missing or stray ENDs.
      const type = prop.value.trim().toUpperCase()
      let at = stack.length - 1
      while (at > 0 && stack[at]!.type !== type) at--
      if (at > 0) stack.length = at
    } else {
      top.props.push(prop)
    }
  }
  return root.children
}

const get = (c: Component, name: string) => c.props.find((p) => p.name === name)

// A zone we can resolve a wall time in: either IANA, or a VTIMEZONE's yearly
// rules for custom names Exchange sometimes sends.
type ZoneResolver = (w: Wall) => number

type Observance = { offsetTo: number; start: Wall; month?: number; byDay?: { n: number; wd: number } }

function parseOffset(s: string | undefined) {
  const m = s?.trim().match(/^([+-])(\d\d)(\d\d)(\d\d)?$/)
  if (!m) return undefined
  const v = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -v : v
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// Day of month of the nth (negative: from the end) weekday in a month.
function nthWeekday(year: number, month: number, n: number, wd: number) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
  return lastDay - ((last - wd + 7) % 7) + (n + 1) * 7
}

function vtimezoneResolver(tz: Component): ZoneResolver | undefined {
  const obs: Observance[] = []
  for (const c of tz.children) {
    if (c.type !== 'STANDARD' && c.type !== 'DAYLIGHT') continue
    const offsetTo = parseOffset(get(c, 'TZOFFSETTO')?.value)
    const start = parseWall(get(c, 'DTSTART')?.value ?? '')
    if (offsetTo === undefined || !start) continue
    const o: Observance = { offsetTo, start: start.wall }
    const rule = get(c, 'RRULE')?.value
    if (rule) {
      const parts = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]))
      const bd = parts.BYDAY?.match(/^([+-]?\d)?([A-Z]{2})$/)
      if (parts.BYMONTH && bd) {
        o.month = Number(parts.BYMONTH)
        o.byDay = { n: Number(bd[1] ?? 1), wd: WEEKDAYS.indexOf(bd[2]!) }
      }
    }
    obs.push(o)
  }
  if (!obs.length) return undefined
  const key = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  // Transition moment (as local wall time) of an observance in a year.
  const transition = (o: Observance, year: number) => {
    if (!o.month || !o.byDay) return o.start.year <= year ? key({ ...o.start }) : undefined
    const day = nthWeekday(year, o.month, o.byDay.n, o.byDay.wd)
    return key({ ...o.start, year, month: o.month, day })
  }
  return (w) => {
    const t = key(w)
    let best: { at: number; o: Observance } | undefined
    for (const year of [w.year, w.year - 1]) {
      for (const o of obs) {
        const at = transition(o, year)
        if (at !== undefined && at <= t && (!best || at > best.at)) best = { at, o }
      }
      if (best) break
    }
    const o = best?.o ?? obs[0]!
    return t - o.offsetTo * 60000
  }
}

function parseWall(v: string): { wall: Wall; utc: boolean; dateOnly: boolean } | undefined {
  const m = v.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return undefined
  return {
    wall: {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4] ?? 0),
      minute: Number(m[5] ?? 0),
      second: Number(m[6] ?? 0),
    },
    utc: !!m[7],
    dateOnly: m[4] === undefined,
  }
}

function parseDuration(v: string | undefined) {
  const m = v?.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return undefined
  const ms = (((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 24 + Number(m[4] ?? 0)) * 60 + Number(m[5] ?? 0)) * 60000 + Number(m[6] ?? 0) * 1000
  return m[1] === '-' ? -ms : ms
}

const isoDate = (w: Wall) => `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`

function person(p: Prop): IcsPerson | undefined {
  const email = p.value.replace(/^mailto:/i, '').trim()
  const name = p.params.CN?.trim()
  if (!email && !name) return undefined
  return name ? { name, email } : { email }
}

export function parseIcs(text: string, opts: IcsOptions = {}): IcsCalendar {
  const fallbackZone = opts.timeZone && isValidTimeZone(opts.timeZone) ? opts.timeZone : 'UTC'
  const calendars = parseComponents(text).filter((c) => c.type === 'VCALENDAR')
  // Some senders omit the VCALENDAR wrapper; accept bare VEVENTs too.
  const top: Component = calendars[0] ?? { type: 'VCALENDAR', props: [], children: parseComponents(text) }
  const method = get(top, 'METHOD')?.value.trim().toUpperCase() || undefined
  const calZone = get(top, 'X-WR-TIMEZONE')?.value.trim()

  const vtz = new Map<string, Component>()
  for (const c of top.children) {
    const id = c.type === 'VTIMEZONE' ? get(c, 'TZID')?.value.trim() : undefined
    if (id) vtz.set(id, c)
  }

  const resolvers = new Map<string, { iana?: string; resolve: ZoneResolver }>()
  const zoneFor = (tzid: string | undefined) => {
    const id = tzid?.trim().replace(/^\//, '')
    if (!id) {
      const z = calZone && isValidTimeZone(calZone) ? calZone : fallbackZone
      return { iana: z, resolve: (w: Wall) => zonedToEpoch(w, z) }
    }
    let r = resolvers.get(id)
    if (r) return r
    // "(UTC+01:00) Amsterdam, Berlin..." style labels carry no usable name.
    const iana = isValidTimeZone(id) ? id : windowsToIana(id)
    const block = vtz.get(tzid!.trim()) ?? vtz.get(id)
    const custom = !iana && block ? vtimezoneResolver(block) : undefined
    const loc = block && get(block, 'X-LIC-LOCATION')?.value.trim()
    const z = iana ?? (loc && isValidTimeZone(loc) ? loc : undefined)
    if (z) r = { iana: z, resolve: (w) => zonedToEpoch(w, z) }
    else if (custom) r = { resolve: custom }
    else r = { iana: fallbackZone, resolve: (w) => zonedToEpoch(w, fallbackZone) }
    resolvers.set(id, r)
    return r
  }

  const readTime = (p: Prop | undefined) => {
    if (!p) return undefined
    const parsed = parseWall(p.value)
    if (!parsed) return undefined
    const dateOnly = parsed.dateOnly || p.params.VALUE?.toUpperCase() === 'DATE'
    if (dateOnly) {
      const w = { ...parsed.wall, hour: 0, minute: 0, second: 0 }
      return { epoch: zonedToEpoch(w, fallbackZone), dateOnly: true, wall: w, zone: undefined }
    }
    if (parsed.utc) return { epoch: zonedToEpoch(parsed.wall, 'UTC'), dateOnly: false, wall: parsed.wall, zone: 'UTC' }
    const z = zoneFor(p.params.TZID)
    return { epoch: z.resolve(parsed.wall), dateOnly: false, wall: parsed.wall, zone: z.iana }
  }

  const events: IcsEvent[] = []
  for (const c of top.children) {
    if (c.type !== 'VEVENT') continue
    const start = readTime(get(c, 'DTSTART'))
    if (!start) continue
    const endProp = readTime(get(c, 'DTEND'))
    const duration = parseDuration(get(c, 'DURATION')?.value)
    let end = endProp?.epoch
    let endDate = endProp?.dateOnly ? isoDate(endProp.wall) : undefined
    if (end === undefined && duration !== undefined) {
      end = start.epoch + duration
      if (start.dateOnly) endDate = isoDate({ ...start.wall, ...wallFromUtc(Date.UTC(start.wall.year, start.wall.month - 1, start.wall.day) + duration) })
    }
    const text = (name: string) => {
      const v = get(c, name)?.value
      return v === undefined ? undefined : unescapeText(v).trim() || undefined
    }
    const seq = Number(get(c, 'SEQUENCE')?.value)
    const org = get(c, 'ORGANIZER')
    const ev: IcsEvent = {
      uid: get(c, 'UID')?.value.trim() ?? '',
      summary: text('SUMMARY') ?? '',
      start: start.epoch,
      allDay: start.dateOnly,
      attendees: [],
    }
    if (Number.isFinite(seq)) ev.sequence = seq
    const description = text('DESCRIPTION')
    if (description) ev.description = description
    const location = text('LOCATION')
    if (location) ev.location = location
    if (end !== undefined) ev.end = end
    if (start.dateOnly) {
      ev.startDate = isoDate(start.wall)
      if (endDate) ev.endDate = endDate
    }
    if (start.zone) ev.timeZone = start.zone
    const rrule = get(c, 'RRULE')?.value.trim()
    if (rrule) ev.rrule = rrule
    const status = get(c, 'STATUS')?.value.trim().toUpperCase()
    if (status) ev.status = status
    const organizer = org && person(org)
    if (organizer) ev.organizer = organizer
    for (const p of c.props) {
      if (p.name !== 'ATTENDEE') continue
      const who = person(p)
      if (!who) continue
      const a: IcsAttendee = { ...who }
      if (p.params.PARTSTAT) a.partstat = p.params.PARTSTAT.toUpperCase()
      if (p.params.ROLE) a.role = p.params.ROLE.toUpperCase()
      if (p.params.RSVP) a.rsvp = p.params.RSVP.toUpperCase() === 'TRUE'
      ev.attendees.push(a)
    }
    const url = get(c, 'URL')?.value.trim()
    if (url) ev.url = url
    const rid = get(c, 'RECURRENCE-ID')
    const ridTime = readTime(rid)
    if (ridTime) ev.recurrenceId = ridTime.dateOnly ? utcMidnight(ridTime.wall) : ridTime.epoch
    const exdates = c.props
      .filter((p) => p.name === 'EXDATE')
      .flatMap((p) => p.value.split(',').map((v) => readTime({ ...p, value: v })))
      .flatMap((t) => (t ? [t.dateOnly ? utcMidnight(t.wall) : t.epoch] : []))
    if (exdates.length) ev.exdates = exdates
    const comment = text('COMMENT')
    if (comment) ev.comment = comment
    const alarms = c.children.flatMap((a) => {
      const minutes = a.type === 'VALARM' ? alarmMinutes(a, ev.start, ev.end, readTime) : undefined
      return minutes === undefined ? [] : [minutes]
    })
    if (alarms.length) ev.alarms = [...new Set(alarms)].sort((a, b) => a - b)
    events.push(ev)
  }
  return method ? { method, events } : { events }
}

// A VALARM's TRIGGER as minutes before the event's start. Only alerts shown to the person count
// (DISPLAY, AUDIO): an EMAIL alarm asks the calendar server to mail someone, which Jefi can't do.
function alarmMinutes(a: Component, start: number, end: number | undefined, readTime: (p: Prop | undefined) => { epoch: number } | undefined) {
  const action = get(a, 'ACTION')?.value.trim().toUpperCase()
  if (action && action !== 'DISPLAY' && action !== 'AUDIO') return undefined
  const trigger = get(a, 'TRIGGER')
  if (!trigger) return undefined
  if (trigger.params.VALUE?.toUpperCase() === 'DATE-TIME') {
    const at = readTime({ ...trigger, params: {} })
    return at ? Math.round((start - at.epoch) / 60000) : undefined
  }
  const offset = parseDuration(trigger.value)
  if (offset === undefined) return undefined
  const from = trigger.params.RELATED?.toUpperCase() === 'END' ? (end ?? start) : start
  return Math.round((start - (from + offset)) / 60000)
}

const utcMidnight = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day)

function wallFromUtc(epoch: number) {
  const d = new Date(epoch)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
