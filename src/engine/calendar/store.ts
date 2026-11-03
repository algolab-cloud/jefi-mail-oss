import type { MailDatabase } from '../db'
import { THREAD_MATCH, linkOf, mailLinkColumns, threadMatchArgs, type LinkRow } from './links'
import { checkTimeZone, endBefore, expandSeries, formatRRule, occurrencesBefore, parseRRule, seriesEnd } from './recurrence'
import type {
  Calendar,
  CalendarEvent,
  CalendarPatch,
  CalendarSource,
  EventInput,
  EventLink,
  EventOccurrence,
  Invite,
  LinkSnapshot,
  MailLinkTarget,
  SaveEventOptions,
  SeriesScope,
} from './types'

// ---------------------------------------------------------------------------
// Calendars and events in mail.db, which is their only store: Jefi's calendars don't sync with a
// provider. Other calendars meet Jefi's by email (iTIP invites and replies), so every event carries
// what that needs: a stable UID, a SEQUENCE, the organizer, attendees with their PARTSTAT, the
// account it speaks as, and the invite it came from. A series is one row with an RRULE, expanded
// when listed; an edited occurrence is an exception row sharing the series' UID.
// ---------------------------------------------------------------------------

/** The calendar migration 17 makes; recreated by ensureLocalCalendar if every local one is gone. */
export const LOCAL_CALENDAR_ID = 'local'
const DAY_MS = 86_400_000

type CalendarRow = {
  id: string
  source: CalendarSource
  name: string
  color: string
  can_write: number
  is_default: number
  hidden: number
  url: string | null
  sync_state: string | null
  refreshed_at: number | null
  created_at: number
  updated_at: number
}

export type EventRow = {
  id: string
  calendar_id: string
  uid: string
  sequence: number
  account_id: string | null
  title: string
  start_at: number
  end_at: number
  all_day: number
  time_zone: string | null
  location: string | null
  description: string | null
  url: string | null
  status: CalendarEvent['status']
  organizer_json: string | null
  attendees_json: string
  recurrence: string | null
  exdates_json: string
  recur_end: number | null
  recurring_master_id: string | null
  recurrence_id: number | null
  alarms_json: string | null
  created_at: number
  updated_at: number
}

export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
/** A UID for an event Jefi makes: globally unique, as RFC 5545 asks. */
export const newUid = () => `${crypto.randomUUID()}@jefi`

/** The zone new timed events are made in: the engine's, which is the person's. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const calendarOf = (row: CalendarRow): Calendar => ({
  id: row.id,
  source: row.source,
  name: row.name,
  color: row.color,
  canWrite: row.can_write === 1,
  isDefault: row.is_default === 1,
  hidden: row.hidden === 1,
  url: row.url,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const eventOf = (row: EventRow, invite: EventLink | null): CalendarEvent => ({
  id: row.id,
  calendarId: row.calendar_id,
  uid: row.uid,
  sequence: row.sequence,
  accountId: row.account_id,
  title: row.title,
  startAt: row.start_at,
  endAt: row.end_at,
  allDay: row.all_day === 1,
  timeZone: row.time_zone,
  location: row.location,
  description: row.description,
  url: row.url,
  status: row.status,
  organizer: row.organizer_json ? JSON.parse(row.organizer_json) : null,
  attendees: JSON.parse(row.attendees_json),
  recurrence: row.recurrence,
  exdates: JSON.parse(row.exdates_json),
  recurringMasterId: row.recurring_master_id,
  recurrenceId: row.recurrence_id,
  alarms: row.alarms_json ? JSON.parse(row.alarms_json) : null,
  invite,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** Events as the UI sees them, their invite links looked up in one query. */
function eventsOf(db: MailDatabase, rows: EventRow[]): CalendarEvent[] {
  if (!rows.length) return []
  const invites = new Map<string, EventLink>()
  const ids = JSON.stringify([...new Set(rows.map((r) => r.id))])
  for (const row of db.query(`SELECT ${EVENT_LINK_COLUMNS} FROM event_links l WHERE l.role = 'invite' AND l.event_id IN (SELECT value FROM json_each(?))`).all(ids) as EventLinkRow[]) {
    invites.set(row.event_id, eventLinkOf(db, row))
  }
  return rows.map((row) => eventOf(row, invites.get(row.id) ?? null))
}

// --- Calendars ------------------------------------------------------------------

const calendarRow = (db: MailDatabase, id: string) => db.query('SELECT * FROM calendars WHERE id = ?').get(id) as CalendarRow | null

export function getCalendar(db: MailDatabase, id: string): Calendar | null {
  const row = calendarRow(db, id)
  return row ? calendarOf(row) : null
}

/** Every calendar, local ones first; guarantees a local calendar and a default exist. */
export function listCalendars(db: MailDatabase): Calendar[] {
  ensureLocalCalendar(db)
  return (db.query("SELECT * FROM calendars ORDER BY source != 'local', is_default DESC, name COLLATE NOCASE, created_at").all() as CalendarRow[]).map(calendarOf)
}

/**
 * Jefi always has a local calendar, and exactly one default calendar, which is a local one. Puts
 * back whatever a deletion took: the default moves to the oldest local calendar.
 */
export function ensureLocalCalendar(db: MailDatabase): Calendar {
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM calendars WHERE source = 'local'").get()) {
      const at = Date.now()
      db.run("INSERT INTO calendars (id, source, name, color, created_at, updated_at) VALUES (?, 'local', 'Personal', '#5b7cfa', ?, ?)", [
        calendarRow(db, LOCAL_CALENDAR_ID) ? newId('cal') : LOCAL_CALENDAR_ID,
        at,
        at,
      ])
    }
    const defaults = db.query("SELECT id FROM calendars WHERE is_default = 1 AND source = 'local' ORDER BY created_at").all() as Array<{ id: string }>
    if (defaults.length === 1 && !db.query("SELECT 1 FROM calendars WHERE is_default = 1 AND source != 'local'").get()) return
    const keep = defaults[0]?.id ?? (db.query("SELECT id FROM calendars WHERE source = 'local' ORDER BY created_at, id LIMIT 1").get() as { id: string }).id
    db.run('UPDATE calendars SET is_default = (id = ?)', [keep])
  })()
  return defaultCalendar(db)
}

export function defaultCalendar(db: MailDatabase): Calendar {
  const row = db.query('SELECT * FROM calendars WHERE is_default = 1').get() as CalendarRow | null
  return row ? calendarOf(row) : ensureLocalCalendar(db)
}

export function createLocalCalendar(db: MailDatabase, input: { name: string; color: string }): Calendar {
  const name = input.name.trim()
  if (!name) throw new Error('Name the calendar')
  const id = newId('cal')
  const at = Date.now()
  db.run("INSERT INTO calendars (id, source, name, color, created_at, updated_at) VALUES (?, 'local', ?, ?, ?, ?)", [id, name, input.color, at, at])
  return getCalendar(db, id)!
}

/** Rename, recolour, hide, or make default (a local calendar only: subscriptions are read-only). */
export function updateCalendar(db: MailDatabase, id: string, patch: CalendarPatch): Calendar {
  db.transaction(() => {
    const row = calendarRow(db, id)
    if (!row) throw new Error('Calendar not found')
    const name = patch.name !== undefined ? patch.name.trim() : row.name
    if (!name) throw new Error('Name the calendar')
    if (patch.isDefault && (row.source !== 'local' || row.can_write !== 1)) throw new Error('Only a calendar of your own can be the default')
    db.run('UPDATE calendars SET name = ?, color = ?, hidden = ?, updated_at = ? WHERE id = ?', [name, patch.color ?? row.color, patch.hidden === undefined ? row.hidden : patch.hidden ? 1 : 0, Date.now(), id])
    if (patch.isDefault) db.run('UPDATE calendars SET is_default = (id = ?)', [id])
  })()
  return getCalendar(db, id)!
}

/** Deletes a calendar and its events. The last local calendar can't go; the default moves on. */
export function deleteCalendar(db: MailDatabase, id: string) {
  db.transaction(() => {
    const row = calendarRow(db, id)
    if (!row) return
    if (row.source === 'local' && (db.query("SELECT count(*) n FROM calendars WHERE source = 'local'").get() as { n: number }).n < 2) {
      throw new Error('Jefi needs at least one calendar of its own')
    }
    deleteEventRows(db, 'calendar_id = ?', [id])
    db.run('DELETE FROM calendars WHERE id = ?', [id])
    ensureLocalCalendar(db)
  })()
}

/** Events and their links, by name rather than by cascade (see deleteAccountData). */
export function deleteEventRows(db: MailDatabase, where: string, args: Array<string | number>) {
  db.run(`DELETE FROM event_links WHERE event_id IN (SELECT id FROM events WHERE ${where})`, args)
  db.run(`DELETE FROM events WHERE ${where}`, args)
}

// --- Events -------------------------------------------------------------------

const eventRow = (db: MailDatabase, id: string) => db.query('SELECT * FROM events WHERE id = ?').get(id) as EventRow | null

export function getEvent(db: MailDatabase, id: string): CalendarEvent | null {
  const row = eventRow(db, id)
  return row ? eventsOf(db, [row])[0]! : null
}

/**
 * The event with this iCalendar UID (the series, or with `recurrenceId` the exception for that
 * occurrence), for matching an organizer's update or cancellation, or an attendee's reply, to the
 * event it's about. Prefers a calendar Jefi can write to, then the oldest.
 */
export function eventByUid(db: MailDatabase, uid: string, recurrenceId?: number): CalendarEvent | null {
  const row = db
    .query(
      `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.uid = ? AND e.recurrence_id IS ?
        ORDER BY c.can_write DESC, c.source != 'local', e.created_at LIMIT 1`,
    )
    .get(uid, recurrenceId ?? null) as EventRow | null
  return row ? eventsOf(db, [row])[0]! : null
}

const seriesOf = (row: EventRow) => ({
  startAt: row.start_at,
  endAt: row.end_at,
  allDay: row.all_day === 1,
  timeZone: row.time_zone,
  recurrence: row.recurrence!,
  exdates: JSON.parse(row.exdates_json) as number[],
})

/**
 * Occurrences overlapping [from, to), by start. Without `calendarIds`, every calendar not hidden;
 * with them, just those (hidden or not). Cancelled events, and invitations the person declined, are
 * left out: the row (and its UID) stays so a later update can still find it.
 */
export function listEvents(db: MailDatabase, from: number, to: number, calendarIds?: string[]): EventOccurrence[] {
  const which = calendarIds ? 'e.calendar_id IN (SELECT value FROM json_each(?))' : 'c.hidden = 0'
  const rows = db
    .query(
      `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id
        WHERE ${which} AND e.status != 'cancelled' AND e.start_at < ?
          AND ((e.recurrence IS NULL AND (e.end_at > ? OR e.start_at >= ?)) OR (e.recurrence IS NOT NULL AND (e.recur_end IS NULL OR e.recur_end >= ?)))`,
    )
    .all(...(calendarIds ? [JSON.stringify(calendarIds)] : []), to, from, from, from) as EventRow[]
  const out: EventOccurrence[] = []
  const events = eventsOf(db, rows)
  rows.forEach((row, i) => {
    const event = events[i]!
    // An invitation the person declined is kept (a later update still finds it) but not shown.
    if (event.attendees.some((a) => a.self && a.partstat === 'declined')) return
    if (!row.recurrence) {
      out.push({ ...event, key: row.id, recurring: false, occurrenceStart: row.recurrence_id ?? row.start_at })
      return
    }
    for (const { start, end } of expandSeries(seriesOf(row), from, to)) out.push({ ...event, startAt: start, endAt: end, key: `${row.id}@${start}`, recurring: true, occurrenceStart: start })
  })
  return out.sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt || (a.key < b.key ? -1 : 1))
}

type Fields = {
  title: string
  start_at: number
  end_at: number
  all_day: number
  time_zone: string | null
  location: string | null
  description: string | null
  url: string | null
  status: CalendarEvent['status']
  organizer_json: string | null
  attendees_json: string
  recurrence: string | null
  account_id: string | null
  alarms_json: string | null
}

/** Whole minutes, each once, soonest alert first; at most a week either side of the start. */
export function normalizeAlarms(alarms: number[]): number[] {
  const week = 7 * 24 * 60
  return [...new Set(alarms.filter(Number.isFinite).map((m) => Math.max(-week, Math.min(week, Math.round(m)))))].sort((a, b) => a - b)
}

/** Checks and normalises an input: all-day events snap to whole UTC days, rules are re-written canonically. */
function fieldsOf(input: EventInput, existing: EventRow | null): Fields {
  if (!Number.isFinite(input.startAt) || !Number.isFinite(input.endAt)) throw new Error('An event needs a start and an end')
  if (input.endAt < input.startAt) throw new Error('An event can’t end before it starts')
  const allDay = input.allDay ?? (existing ? existing.all_day === 1 : false)
  let start = input.startAt
  let end = input.endAt
  if (allDay) {
    start = Math.floor(start / DAY_MS) * DAY_MS
    end = Math.max(start + DAY_MS, Math.ceil(end / DAY_MS) * DAY_MS)
  }
  const timeZone = allDay ? null : (input.timeZone ?? existing?.time_zone ?? localTimeZone())
  if (timeZone) {
    try {
      checkTimeZone(timeZone)
    } catch {
      throw new Error(`Unknown time zone: ${timeZone}`)
    }
  }
  const text = input.recurrence === undefined ? (existing?.recurrence ?? null) : input.recurrence
  const recurrence = text?.trim() ? formatRRule(parseRRule(text)) : null
  return {
    title: input.title.trim(),
    start_at: start,
    end_at: end,
    all_day: allDay ? 1 : 0,
    time_zone: timeZone,
    location: input.location === undefined ? (existing?.location ?? null) : input.location || null,
    description: input.description === undefined ? (existing?.description ?? null) : input.description || null,
    url: input.url === undefined ? (existing?.url ?? null) : input.url || null,
    status: input.status ?? existing?.status ?? 'confirmed',
    organizer_json: input.organizer === undefined ? (existing?.organizer_json ?? null) : input.organizer ? JSON.stringify(input.organizer) : null,
    attendees_json: input.attendees === undefined ? (existing?.attendees_json ?? '[]') : JSON.stringify(input.attendees),
    recurrence,
    account_id: input.accountId === undefined ? (existing?.account_id ?? null) : input.accountId,
    alarms_json: input.alarms === undefined ? (existing?.alarms_json ?? null) : input.alarms ? JSON.stringify(normalizeAlarms(input.alarms)) : null,
  }
}

/** RFC 5546: the organizer's revision goes up when the time, place (or meeting link), recurrence or status changes. */
const significant = (a: Fields, b: Fields) =>
  a.start_at !== b.start_at ||
  a.end_at !== b.end_at ||
  a.all_day !== b.all_day ||
  a.time_zone !== b.time_zone ||
  a.location !== b.location ||
  a.url !== b.url ||
  a.recurrence !== b.recurrence ||
  a.status !== b.status

const recurEnd = (f: Fields, exdates: number[] = []) =>
  f.recurrence ? seriesEnd({ startAt: f.start_at, endAt: f.end_at, allDay: f.all_day === 1, timeZone: f.time_zone, recurrence: f.recurrence, exdates }) : null

type RowExtra = { uid: string; sequence: number; recurring_master_id?: string; recurrence_id?: number; exdates?: number[] }

function insertEvent(db: MailDatabase, calendarId: string, f: Fields, extra: RowExtra): string {
  const id = newId('evt')
  const at = Date.now()
  db.run(
    `INSERT INTO events (id, calendar_id, uid, sequence, account_id, title, start_at, end_at, all_day, time_zone, location, description, url, status, organizer_json,
       attendees_json, recurrence, exdates_json, recur_end, recurring_master_id, recurrence_id, alarms_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, calendarId, extra.uid, extra.sequence, f.account_id, f.title, f.start_at, f.end_at, f.all_day, f.time_zone, f.location, f.description, f.url, f.status,
      f.organizer_json, f.attendees_json, f.recurrence, JSON.stringify(extra.exdates ?? []), recurEnd(f, extra.exdates), extra.recurring_master_id ?? null,
      extra.recurrence_id ?? null, f.alarms_json, at, at,
    ],
  )
  return id
}

function updateEvent(db: MailDatabase, row: EventRow, f: Fields, sequence: number, exdates = JSON.parse(row.exdates_json) as number[]) {
  db.run(
    `UPDATE events SET sequence = ?, account_id = ?, title = ?, start_at = ?, end_at = ?, all_day = ?, time_zone = ?, location = ?, description = ?, url = ?,
       status = ?, organizer_json = ?, attendees_json = ?, recurrence = ?, exdates_json = ?, recur_end = ?, alarms_json = ?, updated_at = ? WHERE id = ?`,
    [
      sequence, f.account_id, f.title, f.start_at, f.end_at, f.all_day, f.time_zone, f.location, f.description, f.url,
      f.status, f.organizer_json, f.attendees_json, f.recurrence, JSON.stringify(exdates), recurEnd(f, exdates), f.alarms_json, Date.now(), row.id,
    ],
  )
}

const fieldsOfRow = (row: EventRow): Fields => ({
  title: row.title,
  start_at: row.start_at,
  end_at: row.end_at,
  all_day: row.all_day,
  time_zone: row.time_zone,
  location: row.location,
  description: row.description,
  url: row.url,
  status: row.status,
  organizer_json: row.organizer_json,
  attendees_json: row.attendees_json,
  recurrence: row.recurrence,
  account_id: row.account_id,
  alarms_json: row.alarms_json,
})

function writableCalendar(db: MailDatabase, id: string): CalendarRow {
  const calendar = calendarRow(db, id)
  if (!calendar) throw new Error('Calendar not found')
  if (calendar.can_write !== 1) throw new Error('This calendar is read-only')
  return calendar
}

function needOccurrence(options: SaveEventOptions, row: EventRow): number {
  const at = options.occurrenceStart
  if (at === undefined) throw new Error('Say which occurrence to change')
  if (at < row.start_at) throw new Error('That occurrence isn’t in the series')
  return at
}

/**
 * Creates or updates an event and returns the row written: the event, the series, the exception
 * made for one occurrence ('this'), or the new series that takes over from an occurrence on
 * ('following', with a UID of its own). Scopes only matter for an occurrence of a series;
 * `occurrenceStart` names it. Creating with a `uid` the calendar already has updates that event
 * instead, so applying an organizer's update is the same call as importing the first invite.
 */
export function saveEvent(db: MailDatabase, input: EventInput, options: SaveEventOptions = {}): CalendarEvent {
  const id = db.transaction(() => {
    const calendarId = input.calendarId ?? (input.id ? undefined : defaultCalendar(db).id)
    let existing = input.id ? eventRow(db, input.id) : null
    if (input.id && !existing) throw new Error('Event not found')
    if (!existing && input.uid) {
      existing = db.query('SELECT * FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id IS NULL').get(calendarId!, input.uid) as EventRow | null
    }
    if (existing && input.calendarId && input.calendarId !== existing.calendar_id) existing = moveEvent(db, existing, input.calendarId, options)
    writableCalendar(db, existing?.calendar_id ?? calendarId!)
    const f = fieldsOf(input, existing)
    const sequenceAfter = (before: Fields, base: number) => input.sequence ?? (significant(before, f) ? base + 1 : base)
    let saved: string
    if (!existing) saved = insertEvent(db, calendarId!, f, { uid: input.uid?.trim() || newUid(), sequence: input.sequence ?? 0 })
    else if (!existing.recurrence || (options.scope ?? 'all') === 'all') {
      let exdates = JSON.parse(existing.exdates_json) as number[]
      if (existing.recurrence && options.occurrenceStart !== undefined) {
        // Edited through one occurrence: move the whole series by the same amount.
        const shift = f.start_at - options.occurrenceStart
        const duration = f.end_at - f.start_at
        f.start_at = existing.start_at + shift
        f.end_at = f.start_at + duration
        exdates = exdates.map((t) => t + shift)
      }
      updateEvent(db, existing, f, sequenceAfter(fieldsOfRow(existing), existing.sequence), exdates)
      saved = existing.id
    } else if (options.scope === 'this') {
      const at = needOccurrence(options, existing)
      addExdate(db, existing, at)
      deleteEventRows(db, 'recurring_master_id = ? AND recurrence_id = ?', [existing.id, at])
      const occurrence = { ...fieldsOfRow(existing), start_at: at, end_at: at + existing.end_at - existing.start_at, recurrence: null }
      saved = insertEvent(db, existing.calendar_id, { ...f, recurrence: null }, {
        uid: existing.uid,
        sequence: sequenceAfter(occurrence, existing.sequence),
        recurring_master_id: existing.id,
        recurrence_id: at,
      })
    } else {
      const at = needOccurrence(options, existing)
      if (at === existing.start_at) {
        updateEvent(db, existing, f, sequenceAfter(fieldsOfRow(existing), existing.sequence))
        saved = existing.id
      } else {
        let recurrence = f.recurrence
        if (input.recurrence === undefined && recurrence) {
          // The rest of a COUNT series carries on with the occurrences it has left.
          const rule = parseRRule(recurrence)
          if (rule.count !== undefined) recurrence = formatRRule({ ...rule, count: Math.max(1, rule.count - occurrencesBefore(seriesOf(existing), at)) })
        }
        const exdates = (JSON.parse(existing.exdates_json) as number[]).filter((t) => t >= at)
        truncate(db, existing, at)
        saved = insertEvent(db, existing.calendar_id, { ...f, recurrence }, { uid: newUid(), sequence: 0, exdates })
      }
    }
    if (input.invite) linkEvent(db, saved, input.invite, undefined, 'invite')
    for (const target of input.links ?? []) linkEvent(db, saved, target)
    return saved
  })()
  return getEvent(db, id)!
}

/**
 * Moves an event to another calendar before the rest of an edit applies. A series moves with its
 * exceptions, since they share a UID and belong together; so one occurrence (an exception, or a
 * 'this'/'following' edit) can't move on its own. Where an event lives is private, so SEQUENCE stays.
 */
function moveEvent(db: MailDatabase, row: EventRow, calendarId: string, options: SaveEventOptions): EventRow {
  writableCalendar(db, row.calendar_id)
  writableCalendar(db, calendarId)
  const partial = !!row.recurrence && (options.scope ?? 'all') !== 'all' && options.occurrenceStart !== row.start_at
  if (row.recurring_master_id || partial) throw new Error('Only a whole series can move to another calendar')
  if (db.query('SELECT 1 FROM events WHERE calendar_id = ? AND uid = ?').get(calendarId, row.uid)) throw new Error('That calendar already has this event')
  db.run('UPDATE events SET calendar_id = ? WHERE id = ? OR recurring_master_id = ?', [calendarId, row.id, row.id])
  return eventRow(db, row.id)!
}

function addExdate(db: MailDatabase, row: EventRow, at: number) {
  const exdates = [...new Set([...(JSON.parse(row.exdates_json) as number[]), at])].sort((a, b) => a - b)
  updateEvent(db, row, fieldsOfRow(row), row.sequence + 1, exdates)
}

/** Ends a series just before `at`, and drops its exceptions from there on. */
function truncate(db: MailDatabase, row: EventRow, at: number) {
  const exdates = (JSON.parse(row.exdates_json) as number[]).filter((t) => t < at)
  updateEvent(db, row, { ...fieldsOfRow(row), recurrence: endBefore(row.recurrence!, at, row.all_day === 1) }, row.sequence + 1, exdates)
  deleteEventRows(db, 'recurring_master_id = ? AND recurrence_id >= ?', [row.id, at])
}

/**
 * Deletes an event. For an occurrence of a series, `scope` says how much: just it ('this', an
 * EXDATE), it and later ones ('following', the rule gets an UNTIL) or the series ('all'). An
 * exception row counts as its occurrence. Returns false when there was nothing to delete.
 * To record an organizer's cancellation instead, save the event with status 'cancelled'.
 */
export function deleteEvent(db: MailDatabase, id: string, scope: SeriesScope = 'all', occurrenceStart?: number): boolean {
  return db.transaction(() => {
    const row = eventRow(db, id)
    if (!row) return false
    writableCalendar(db, row.calendar_id)
    const master = row.recurring_master_id ? eventRow(db, row.recurring_master_id) : null
    if (master?.recurrence && row.recurrence_id !== null) {
      // An exception stands in for its occurrence (already an EXDATE): 'this' drops it; wider scopes act on the series.
      if (scope === 'this') deleteEventRows(db, 'id = ?', [row.id])
      else deleteEvent(db, master.id, scope, row.recurrence_id)
      return true
    }
    if (!row.recurrence || scope === 'all') {
      deleteEventRows(db, 'id = ? OR recurring_master_id = ?', [row.id, row.id])
      return true
    }
    const at = needOccurrence({ occurrenceStart }, row)
    if (scope === 'this') {
      addExdate(db, row, at)
      deleteEventRows(db, 'recurring_master_id = ? AND recurrence_id = ?', [row.id, at])
    } else if (at <= row.start_at) deleteEventRows(db, 'id = ? OR recurring_master_id = ?', [row.id, row.id])
    else truncate(db, row, at)
    return true
  })()
}

// --- Links --------------------------------------------------------------------

type EventLinkRow = LinkRow & { event_id: string; role: EventLink['role'] }
const EVENT_LINK_COLUMNS = 'l.id, l.event_id, l.role, l.kind, l.account_id, l.target_ref, l.message_id_header, l.snapshot_json, l.created_at'
const eventLinkOf = (db: MailDatabase, row: EventLinkRow): EventLink => ({ ...linkOf(db, row), eventId: row.event_id, role: row.role })

export function eventLinks(db: MailDatabase, eventId: string): EventLink[] {
  return (db.query(`SELECT ${EVENT_LINK_COLUMNS} FROM event_links l WHERE l.event_id = ? ORDER BY l.created_at, l.rowid`).all(eventId) as EventLinkRow[]).map((row) => eventLinkOf(db, row))
}

/**
 * Links an event to mail (idempotent per target), snapshotting the mail as it is now. An event has
 * at most one 'invite' link: a newer invite (the organizer's update) replaces the older one.
 */
export function linkEvent(db: MailDatabase, eventId: string, target: MailLinkTarget, snapshot?: LinkSnapshot, role: EventLink['role'] = 'related'): EventLink {
  if (target.kind !== 'thread' && target.kind !== 'message') throw new Error('Events link to conversations and messages')
  if (role === 'invite' && target.kind !== 'message') throw new Error('An invite is a message')
  if (!eventRow(db, eventId)) throw new Error('Event not found')
  const columns = mailLinkColumns(db, target, snapshot)
  const id = db.transaction(() => {
    if (role === 'invite') db.run("DELETE FROM event_links WHERE event_id = ? AND role = 'invite' AND NOT (account_id IS ? AND target_ref IS ?)", [eventId, columns.accountId, columns.ref])
    const same = db.query('SELECT id FROM event_links WHERE event_id = ? AND kind = ? AND account_id = ? AND target_ref = ?').get(eventId, target.kind, columns.accountId, columns.ref) as { id: string } | null
    const id = same?.id ?? newId('elink')
    if (same) db.run(`UPDATE event_links SET message_id_header = ?, snapshot_json = ?${role === 'invite' ? ", role = 'invite'" : ''} WHERE id = ?`, [columns.header, JSON.stringify(columns.snapshot), id])
    else {
      db.run('INSERT INTO event_links (id, event_id, kind, role, account_id, target_ref, message_id_header, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id, eventId, target.kind, role, columns.accountId, columns.ref, columns.header, JSON.stringify(columns.snapshot), Date.now(),
      ])
    }
    return id
  })()
  return eventLinks(db, eventId).find((l) => l.id === id)!
}

export function unlinkEvent(db: MailDatabase, linkId: string): boolean {
  return db.run('DELETE FROM event_links WHERE id = ?', [linkId]).changes > 0
}

/** The event a link belongs to, for the change event an unlink emits. */
export const eventOfLink = (db: MailDatabase, linkId: string) =>
  db.query('SELECT e.id, e.calendar_id FROM event_links l JOIN events e ON e.id = l.event_id WHERE l.id = ?').get(linkId) as { id: string; calendar_id: string } | null

/** Events linked to a conversation or any of its messages (invites included), by start. */
export function eventsForThread(db: MailDatabase, accountId: string, threadId: string): CalendarEvent[] {
  return eventsOf(
    db,
    db.query(`SELECT DISTINCT e.* FROM event_links l JOIN events e ON e.id = l.event_id WHERE ${THREAD_MATCH} ORDER BY e.start_at, e.id`).all(...threadMatchArgs(db, accountId, threadId)) as EventRow[],
  )
}

// --- Invites ------------------------------------------------------------------

/** Biggest text/calendar part kept: invites are a few KB; anything this size is not one to parse on the fly. */
export const MAX_INVITE_BYTES = 256 * 1024

export type StoredInvite = { method: string | null; filename: string | null; ics: string }

/** Replaces a message's stored invites; called with its body (mail-store storeBody). */
export function storeInvites(db: MailDatabase, messageRowId: number, invites: StoredInvite[]) {
  db.run('DELETE FROM invites WHERE message_id = ?', [messageRowId])
  const add = db.prepare('INSERT INTO invites (message_id, idx, method, filename, ics) VALUES (?, ?, ?, ?, ?)')
  invites.forEach((invite, index) => add.run(messageRowId, index, invite.method, invite.filename, invite.ics))
}

/** The text/calendar parts of a message (its UI id), in the order the message has them. */
export function invitesForMessage(db: MailDatabase, accountId: string, messageId: string): Invite[] {
  const match = messageId.match(/-(\d+)$/)
  if (!match) return []
  return (
    db
      .query('SELECT i.idx, i.method, i.filename, i.ics FROM invites i JOIN messages m ON m.id = i.message_id WHERE i.message_id = ? AND m.account_id = ? ORDER BY i.idx')
      .all(Number(match[1]), accountId) as Array<{ idx: number; method: string | null; filename: string | null; ics: string }>
  ).map((r) => ({ index: r.idx, method: r.method, filename: r.filename, ics: r.ics }))
}
