import { parseIcs, type IcsAttendee, type IcsEvent } from '../../detect/ics'
import { isValidTimeZone } from '../../detect/tz'
import type { DraftFields } from '../../data'
import type { MailDatabase } from '../db'
import type { OutgoingCalendar, ReplyHeaders } from '../mime'
import { replyReferences } from '../mime'
import { blockedSenders, screenedSenders } from '../screener'
import { uiThreadId } from '../threading'
import { writeCalendar, type VEventOut } from './ics-write'
import { meetingProvider } from './meeting'
import { expandSeries } from './recurrence'
import { eventByUid, getEvent, localTimeZone, saveEvent } from './store'
import type { Attendee, CalendarEvent, EventInput, Invite, InviteResponse, InviteState, InviteSummary, InviteView, Organizer, PartStat } from './types'

// ---------------------------------------------------------------------------
// Invitations by email (iTIP, RFC 5546, carried as iMIP, RFC 6047). Nothing signs in to Google or
// Microsoft: their invitations arrive as text/calendar parts (stored raw in `invites`), and Jefi's
// answers and its own invitations leave as mail through the outbox.
//
// Received: REQUEST adds or updates the event (in the calendar it already lives in, else the
// default), CANCEL marks it cancelled, REPLY records an attendee's answer on an event Jefi organizes.
// SEQUENCE orders revisions: an older one than the calendar has changes nothing. Invites from Junk,
// a blocked sender or one waiting in the Screener aren't applied; they wait for the person to answer.
// "Us" is the receiving account's address (Jefi has no aliases yet; `selves` takes a list for when
// it does). invite_state records what became of each message, so each is applied once.
// ---------------------------------------------------------------------------

export type ItipMethod = 'REQUEST' | 'CANCEL' | 'REPLY'
type Itip = { method: ItipMethod; events: IcsEvent[] }

const ITIP = new Set<string>(['REQUEST', 'CANCEL', 'REPLY'])
const DAY = 86_400_000

const lower = (s: string | undefined | null) => (s ?? '').trim().toLowerCase()

/**
 * The iTIP content of a message's calendar parts, deduplicated: Gmail and Outlook send the same
 * invite inline and again as invite.ics (sometimes labelled PUBLISH), so events are kept once per
 * UID + SEQUENCE + RECURRENCE-ID. The method is the first iTIP one found, the part's Content-Type
 * `method=` before its METHOD line.
 */
export function itipOf(invites: Array<Pick<Invite, 'method' | 'ics'>>, timeZone = localTimeZone()): Itip | null {
  let method: ItipMethod | undefined
  const seen = new Set<string>()
  const events: IcsEvent[] = []
  for (const invite of invites) {
    const parsed = parseIcs(invite.ics, { timeZone })
    const partMethod = (invite.method ?? parsed.method ?? '').toUpperCase()
    if (ITIP.has(partMethod)) method ??= partMethod as ItipMethod
    else if (partMethod && partMethod !== 'PUBLISH') continue
    if (method && ITIP.has(partMethod) && partMethod !== method) continue
    for (const ev of parsed.events) {
      if (!ev.uid) continue
      const key = `${ev.uid}\u0000${ev.sequence ?? 0}\u0000${ev.recurrenceId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push(ev)
    }
  }
  return method && events.length ? { method, events } : null
}

// --- Messages -----------------------------------------------------------------------------------

type MessageRow = { id: number; account_id: string; thread_id: string | null; from_email: string | null; from_name: string | null; message_id: string | null; references_json: string; subject: string }

const messageRow = (db: MailDatabase, accountId: string, rowId: number) =>
  db.query('SELECT id, account_id, thread_id, from_email, from_name, message_id, references_json, subject FROM messages WHERE id = ? AND account_id = ?').get(rowId, accountId) as MessageRow | null

const rowIdOf = (messageId: string) => {
  const match = messageId.match(/-(\d+)$/)
  return match ? Number(match[1]) : null
}

const uiMessageId = (row: MessageRow) => `${uiThreadId(row.account_id, row.thread_id, row.id)}-${row.id}`

const invitesOfRow = (db: MailDatabase, rowId: number) => db.query('SELECT method, ics FROM invites WHERE message_id = ? ORDER BY idx').all(rowId) as Array<Pick<Invite, 'method' | 'ics'>>

/** The addresses that are "us" for an account: its own, lowercased. */
export function selfAddresses(db: MailDatabase, accountId: string): string[] {
  const row = db.query('SELECT email FROM accounts WHERE id = ?').get(accountId) as { email: string } | null
  return row ? [lower(row.email)] : []
}

/** Mail the person hasn't vouched for: in Junk, from a blocked sender, or waiting in the Screener. */
function untrusted(db: MailDatabase, row: MessageRow, selves: string[]) {
  const from = lower(row.from_email)
  if (!from) return true
  if (blockedSenders(db, row.account_id).has(from)) return true
  if (selves[0] && screenedSenders(db, row.account_id, selves[0]).has(from)) return true
  return !!db
    .query("SELECT 1 FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id WHERE mm.message_id = ? AND mb.special_use = '\\Junk' LIMIT 1")
    .get(row.id)
}

const stateOf = (db: MailDatabase, rowId: number) => (db.query('SELECT state FROM invite_state WHERE message_id = ?').get(rowId) as { state: InviteState } | null)?.state ?? null
const setState = (db: MailDatabase, rowId: number, state: InviteState) =>
  db.run('INSERT INTO invite_state (message_id, state, processed_at) VALUES (?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET state = excluded.state, processed_at = excluded.processed_at', [rowId, state, Date.now()])

// --- iCalendar → events -------------------------------------------------------------------------

const PARTSTATS = new Set<PartStat>(['needs-action', 'accepted', 'declined', 'tentative', 'delegated'])
const partstatOf = (s: string | undefined): PartStat => (PARTSTATS.has(lower(s) as PartStat) ? (lower(s) as PartStat) : 'needs-action')
const ROLES: Record<string, Attendee['role']> = { 'REQ-PARTICIPANT': 'required', 'OPT-PARTICIPANT': 'optional', CHAIR: 'chair', 'NON-PARTICIPANT': 'non-participant' }

/** The invite's attendees, ours marked `self` with `partstat`; added if the invite reached us another way (a list). */
function attendeesOf(ev: IcsEvent, selves: string[], partstat: PartStat): Attendee[] {
  const out: Attendee[] = ev.attendees.map((a: IcsAttendee) => {
    const self = selves.includes(lower(a.email))
    return {
      email: a.email,
      ...(a.name && a.name !== a.email ? { name: a.name } : {}),
      ...(a.role && ROLES[a.role] ? { role: ROLES[a.role] } : {}),
      partstat: self ? partstat : partstatOf(a.partstat),
      ...(a.rsvp ? { rsvp: true } : {}),
      ...(self ? { self: true } : {}),
    }
  })
  if (!out.some((a) => a.self) && selves[0]) out.push({ email: selves[0], partstat, self: true })
  return out
}

const organizerOf = (ev: IcsEvent): Organizer | null => (ev.organizer?.email ? { email: ev.organizer.email, ...(ev.organizer.name ? { name: ev.organizer.name } : {}) } : null)

const statusOf = (s: string | undefined): CalendarEvent['status'] => (s === 'CANCELLED' ? 'cancelled' : s === 'TENTATIVE' ? 'tentative' : 'confirmed')

/** Times as the store keeps them: all-day events on UTC midnights, timed ones in the organizer's zone. */
function timesOf(ev: IcsEvent) {
  if (ev.allDay && ev.startDate) {
    const startAt = Date.parse(`${ev.startDate}T00:00:00Z`)
    const endAt = ev.endDate ? Date.parse(`${ev.endDate}T00:00:00Z`) : startAt + DAY
    return { startAt, endAt: Math.max(endAt, startAt + DAY), allDay: true, timeZone: null }
  }
  const zone = ev.timeZone && isValidTimeZone(ev.timeZone) ? ev.timeZone : undefined
  return { startAt: ev.start, endAt: Math.max(ev.end ?? ev.start, ev.start), allDay: false, timeZone: zone }
}

function inputOf(ev: IcsEvent, accountId: string, attendees: Attendee[], invite: EventInput['invite']): EventInput {
  return {
    uid: ev.uid,
    sequence: ev.sequence ?? 0,
    accountId,
    title: ev.summary || '(no title)',
    ...timesOf(ev),
    location: ev.location ?? null,
    description: ev.description ?? null,
    url: ev.url ?? null,
    status: statusOf(ev.status),
    organizer: organizerOf(ev),
    attendees,
    recurrence: ev.recurrenceId == null ? (ev.rrule ?? null) : null,
    // The organizer's alerts are a suggestion for a new event; once it's ours, the person's choice stands.
    ...(ev.alarms ? { alarms: ev.alarms } : {}),
    invite,
  }
}

const sameOrganizer = (event: CalendarEvent, ev: IcsEvent) => !event.organizer || !ev.organizer || lower(event.organizer.email) === lower(ev.organizer.email)

/** A save that keeps the series' SEQUENCE: splitting off an exception is the organizer's revision, not ours. */
function withSequenceKept<T>(db: MailDatabase, event: CalendarEvent, fn: () => T): T {
  const result = fn()
  db.run('UPDATE events SET sequence = ? WHERE id = ?', [event.sequence, event.id])
  return result
}

function setExdates(db: MailDatabase, eventId: string, exdates: number[]) {
  db.run('UPDATE events SET exdates_json = ? WHERE id = ?', [JSON.stringify([...new Set(exdates)].sort((a, b) => a - b)), eventId])
}

/** saveEvent, falling back to a one-off event when the organizer's RRULE is outside what Jefi expands. */
function saveTolerant(db: MailDatabase, input: EventInput, options?: Parameters<typeof saveEvent>[2]) {
  try {
    return saveEvent(db, input, options)
  } catch (err) {
    if (!input.recurrence) throw err
    return saveEvent(db, { ...input, recurrence: null }, options)
  }
}

type Applied = CalendarEvent | 'stale' | 'ignored'

/**
 * A REQUEST's event into the calendar. A newer SEQUENCE asks everyone again (our answer goes back
 * to NEEDS-ACTION); the same one keeps our answer. `partstat` is set when the person is answering.
 */
function applyRequest(db: MailDatabase, accountId: string, ev: IcsEvent, selves: string[], invite: EventInput['invite'], partstat?: PartStat): Applied {
  const existing = eventByUid(db, ev.uid, ev.recurrenceId ?? undefined)
  const sequence = ev.sequence ?? 0
  if (existing) {
    if (existing.organizer && selves.includes(lower(existing.organizer.email))) return 'ignored'
    if (sameOrganizer(existing, ev)) {
      if (sequence < existing.sequence) return 'stale'
      // A cancellation stands until the organizer sends a newer revision (RFC 5546 bumps SEQUENCE for
      // a CANCEL); the invitation it cancelled, applied after it, mustn't bring the event back.
      if (existing.status === 'cancelled' && sequence <= existing.sequence) return 'stale'
    } else if (existing.status !== 'cancelled') return 'ignored'
    // (A cancellation from someone else, kept before its invitation arrived, gives way to the real one.)
  }
  const ours = existing?.attendees.find((a) => a.self)?.partstat
  const keep = existing && sequence === existing.sequence ? ours : undefined
  const input = inputOf(ev, accountId, attendeesOf(ev, selves, partstat ?? keep ?? 'needs-action'), invite)
  let saved: CalendarEvent
  if (existing) saved = saveTolerant(db, { ...input, id: existing.id, alarms: undefined })
  else if (ev.recurrenceId != null) saved = addException(db, ev, input)
  else saved = saveTolerant(db, input)
  if (ev.exdates?.length && saved.recurrence) setExdates(db, saved.id, ev.exdates)
  return getEvent(db, saved.id)!
}

/** One occurrence the organizer changed (RECURRENCE-ID), under its series when Jefi has it. */
function addException(db: MailDatabase, ev: IcsEvent, input: EventInput): CalendarEvent {
  const at = ev.recurrenceId!
  const master = eventByUid(db, ev.uid)
  if (master?.recurrence && at >= master.startAt) {
    return withSequenceKept(db, master, () => saveEvent(db, { ...input, id: master.id, uid: undefined, recurrence: null }, { scope: 'this', occurrenceStart: at }))
  }
  // Only the one occurrence was sent to us: keep it as its own row, marked as that occurrence.
  const { invite, ...rest } = input
  const saved = saveEvent(db, { ...rest, uid: undefined })
  db.run('UPDATE events SET uid = ?, recurrence_id = ? WHERE id = ?', [ev.uid, at, saved.id])
  if (invite) saveEvent(db, { id: saved.id, title: saved.title, startAt: saved.startAt, endAt: saved.endAt, invite })
  return getEvent(db, saved.id)!
}

function applyCancel(db: MailDatabase, accountId: string, ev: IcsEvent, selves: string[], invite: EventInput['invite']): Applied {
  const sequence = ev.sequence ?? 0
  const existing = eventByUid(db, ev.uid, ev.recurrenceId ?? undefined)
  if (!existing && ev.recurrenceId == null) {
    // The cancellation came before the invitation (a first sync fetches the newest mail first, and
    // so can a Mac back from a week away). Keep the event, cancelled and so hidden, for the
    // invitation to find when it's applied after, rather than add a meeting that's off.
    return saveTolerant(db, { ...inputOf(ev, accountId, attendeesOf(ev, selves, 'needs-action'), invite), status: 'cancelled' })
  }
  if (!existing) {
    // One occurrence of a series we have, cancelled: drop it from the series.
    const master = ev.recurrenceId != null ? eventByUid(db, ev.uid) : null
    if (!master?.recurrence || !sameOrganizer(master, ev) || sequence < master.sequence) return master ? 'stale' : 'ignored'
    setExdates(db, master.id, [...master.exdates, ev.recurrenceId!])
    return getEvent(db, master.id)!
  }
  if (existing.organizer && selves.includes(lower(existing.organizer.email))) return 'ignored'
  if (!sameOrganizer(existing, ev)) return 'ignored'
  if (sequence < existing.sequence) return 'stale'
  return saveEvent(db, { id: existing.id, title: existing.title, startAt: existing.startAt, endAt: existing.endAt, status: 'cancelled', sequence: Math.max(sequence, existing.sequence), invite })
}

/** An attendee's answer to an event we organize. Only the sender's own attendee line counts. */
function applyReply(db: MailDatabase, ev: IcsEvent, from: string, selves: string[]): Applied {
  const existing = eventByUid(db, ev.uid, ev.recurrenceId ?? undefined) ?? (ev.recurrenceId != null ? eventByUid(db, ev.uid) : null)
  if (!existing?.organizer || !selves.includes(lower(existing.organizer.email))) return 'ignored'
  if ((ev.sequence ?? 0) < existing.sequence) return 'stale'
  const known = new Set(existing.attendees.map((a) => lower(a.email)))
  // Only the sender's own line: anyone could otherwise answer for someone else. (A reply sent from an
  // alias of the attendee is ignored, the price of that.)
  const answer = ev.attendees.find((a) => lower(a.email) === from)
  if (!answer) return 'ignored'
  const email = lower(answer.email)
  const partstat = partstatOf(answer.partstat)
  const attendees = known.has(email)
    ? existing.attendees.map((a) => (lower(a.email) === email ? { ...a, partstat } : a))
    : [...existing.attendees, { email: answer.email, ...(answer.name ? { name: answer.name } : {}), partstat }]
  return saveEvent(db, { id: existing.id, title: existing.title, startAt: existing.startAt, endAt: existing.endAt, attendees })
}

// --- Received invites ---------------------------------------------------------------------------

/**
 * Applies one message's invite to the calendar and records the outcome. Returns the calendars it
 * changed (for calendarChanged).
 */
export function applyInviteMessage(db: MailDatabase, accountId: string, rowId: number, selves = selfAddresses(db, accountId)): string[] {
  const row = messageRow(db, accountId, rowId)
  if (!row) return []
  const touched = new Set<string>()
  const state = db.transaction((): InviteState => {
    const from = lower(row.from_email)
    if (selves.includes(from)) return 'own'
    const itip = itipOf(invitesOfRow(db, rowId))
    if (!itip) return 'ignored'
    if (untrusted(db, row, selves)) return 'pending'
    const invite = { kind: 'message' as const, accountId, messageId: uiMessageId(row) }
    // A series before its exceptions, so they land under it.
    const events = [...itip.events].sort((a, b) => (a.recurrenceId == null ? 0 : 1) - (b.recurrenceId == null ? 0 : 1))
    const results = events.map((ev) =>
      itip.method === 'REQUEST' ? applyRequest(db, accountId, ev, selves, invite) : itip.method === 'CANCEL' ? applyCancel(db, accountId, ev, selves, invite) : applyReply(db, ev, from, selves),
    )
    for (const r of results) if (typeof r === 'object') touched.add(r.calendarId)
    return touched.size ? 'applied' : results.includes('stale') ? 'stale' : 'ignored'
  })()
  setState(db, rowId, state)
  return [...touched]
}

/** Every stored invite of the account not applied yet, oldest first. Returns the calendars changed. */
export function applyNewInvites(db: MailDatabase, accountId: string): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT m.id, m.date FROM invites i JOIN messages m ON m.id = i.message_id
        LEFT JOIN invite_state s ON s.message_id = i.message_id
        WHERE m.account_id = ? AND s.message_id IS NULL ORDER BY m.date, m.id`,
    )
    .all(accountId) as Array<{ id: number }>
  if (!rows.length) return []
  const selves = selfAddresses(db, accountId)
  const touched = new Set<string>()
  for (const { id } of rows) {
    try {
      for (const c of applyInviteMessage(db, accountId, id, selves)) touched.add(c)
    } catch (err) {
      // A malformed invite mustn't hold up the rest; it stays readable in the message.
      setState(db, id, 'ignored')
      console.warn(`invite ${id}: ${(err as Error)?.message ?? err}`)
    }
  }
  return [...touched]
}

/** What the reader's invite card shows for a message, or null when it carries no iTIP invite. */
export function inviteView(db: MailDatabase, accountId: string, messageId: string, timeZone = localTimeZone()): InviteView | null {
  const rowId = rowIdOf(messageId)
  const row = rowId === null ? null : messageRow(db, accountId, rowId)
  if (!row) return null
  const itip = itipOf(invitesOfRow(db, row.id), timeZone)
  if (!itip) return null
  const selves = selfAddresses(db, accountId)
  const ev = itip.events.find((e) => e.recurrenceId == null) ?? itip.events[0]!
  const local = eventByUid(db, ev.uid, ev.recurrenceId ?? undefined)
  const mine = local?.attendees.find((a) => a.self)
  const times = timesOf(ev)
  const answered = itip.method === 'REPLY' ? ev.attendees.find((a) => lower(a.email) === lower(row.from_email)) ?? ev.attendees[0] : undefined
  return {
    method: itip.method,
    state: stateOf(db, row.id) ?? 'new',
    uid: ev.uid,
    sequence: ev.sequence ?? 0,
    recurrenceId: ev.recurrenceId ?? null,
    title: ev.summary || '(no title)',
    startAt: times.startAt,
    endAt: times.endAt,
    allDay: times.allDay,
    timeZone: times.timeZone ?? null,
    location: ev.location ?? null,
    description: ev.description ?? null,
    recurrence: ev.rrule ?? null,
    organizer: organizerOf(ev),
    attendees: attendeesOf(ev, selves, mine?.partstat ?? partstatOf(ev.attendees.find((a) => selves.includes(lower(a.email)))?.partstat)),
    eventId: local?.id ?? null,
    calendarId: local?.calendarId ?? null,
    response: itip.method === 'REQUEST' ? (local && mine ? (mine.partstat ?? 'needs-action') : null) : null,
    cancelled: itip.method === 'CANCEL' || local?.status === 'cancelled',
    outdated: !!local && (ev.sequence ?? 0) < local.sequence,
    ...(answered ? { replyFrom: { email: answered.email, ...(answered.name ? { name: answered.name } : {}), partstat: partstatOf(answered.partstat) } } : {}),
  }
}

/**
 * Invitations still waiting for our answer, soonest first: events made from a received invite where
 * our attendee line is NEEDS-ACTION, not cancelled and not over by `now`. A series counts by its next
 * occurrence (within a year); an exception is left out when its series is listed, since answering
 * answers both. Invites held back (Junk, blocked, Screener) have no event and aren't listed.
 */
export function pendingInvites(db: MailDatabase, now = Date.now()): InviteSummary[] {
  const rows = db
    .query(
      `SELECT DISTINCT e.id FROM events e JOIN event_links l ON l.event_id = e.id AND l.role = 'invite'
        WHERE e.status != 'cancelled'
          AND ((e.recurrence IS NULL AND e.end_at > ?) OR (e.recurrence IS NOT NULL AND (e.recur_end IS NULL OR e.recur_end >= ?)))`,
    )
    .all(now, now) as Array<{ id: string }>
  const found: Array<{ summary: InviteSummary; master: string | null }> = []
  for (const { id } of rows) {
    const event = getEvent(db, id)
    const target = event?.invite?.target
    if (!event || target?.kind !== 'message' || !target.accountId) continue
    if (event.attendees.find((a) => a.self)?.partstat !== 'needs-action') continue
    let { startAt, endAt } = event
    if (event.recurrence) {
      const next = expandSeries({ ...event, recurrence: event.recurrence }, now, now + 366 * DAY).find((o) => o.end > now)
      if (!next) continue
      startAt = next.start
      endAt = next.end
    }
    // A UI message id is its conversation's id and its row: `${threadId}-${rowId}`.
    const rowId = rowIdOf(target.messageId)
    const threadId = rowId === null ? target.messageId : target.messageId.slice(0, -`-${rowId}`.length)
    const summary: InviteSummary = {
      eventId: event.id,
      title: event.title,
      startAt,
      endAt,
      allDay: event.allDay,
      timeZone: event.timeZone,
      location: event.location,
      organizer: event.organizer,
      accountId: target.accountId,
      threadId,
      messageId: target.messageId,
      recurring: !!event.recurrence,
    }
    found.push({ summary, master: event.recurringMasterId })
  }
  const listed = new Set(found.map((f) => f.summary.eventId))
  return found
    .filter((f) => !f.master || !listed.has(f.master))
    .map((f) => f.summary)
    .sort((a, b) => a.startAt - b.startAt || (a.eventId < b.eventId ? -1 : 1))
}

// --- Outgoing -----------------------------------------------------------------------------------

/** A queued iTIP mail: what the engine hands the outbox. */
export type ItipMail = { mail: DraftFields; calendar: OutgoingCalendar; reply?: ReplyHeaders }

const RESPONSE_LABEL: Record<InviteResponse, { subject: string; verb: string }> = {
  accepted: { subject: 'Accepted', verb: 'accepted' },
  tentative: { subject: 'Tentatively accepted', verb: 'tentatively accepted' },
  declined: { subject: 'Declined', verb: 'declined' },
}

/** "Monday 5 October 2026, 14:00 – 15:00 (Europe/Berlin)", in the event's zone. */
export function whenText(e: Pick<CalendarEvent, 'startAt' | 'endAt' | 'allDay' | 'timeZone'>, locale = 'en-GB') {
  if (e.allDay) {
    const day = (t: number) => new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(t)
    const last = e.endAt - DAY
    return last > e.startAt ? `${day(e.startAt)} – ${day(last)} (all day)` : `${day(e.startAt)} (all day)`
  }
  const zone = e.timeZone ?? 'UTC'
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: zone })
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: zone })
  const sameDay = date.format(e.startAt) === date.format(e.endAt)
  const end = sameDay ? time.format(e.endAt) : `${date.format(e.endAt)}, ${time.format(e.endAt)}`
  return `${date.format(e.startAt)}, ${time.format(e.startAt)} – ${end} (${zone})`
}

const personText = (p: { name?: string; email: string }) => (p.name ? `${p.name} <${p.email}>` : p.email)

const vevent = (e: CalendarEvent, extra: Partial<VEventOut> = {}): VEventOut => ({
  uid: e.uid,
  sequence: e.sequence,
  title: e.title,
  startAt: e.startAt,
  endAt: e.endAt,
  allDay: e.allDay,
  timeZone: e.timeZone,
  location: e.location,
  description: e.description,
  url: e.url,
  status: e.status === 'cancelled' ? 'CANCELLED' : e.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
  organizer: e.organizer,
  attendees: e.attendees,
  recurrence: e.recurrence,
  exdates: e.exdates,
  recurrenceId: e.recurrenceId,
  // Only alerts chosen for this event: the person's default is theirs, not their guests'.
  alarms: e.alarms ?? undefined,
  ...extra,
})

/**
 * Answers the invite in a message: the calendar gets (or keeps) the event with our answer, and the
 * organizer gets a REPLY. Accepted and tentative events show in the calendar; a declined one stays
 * stored but hidden (listEvents), so a later update can still find it. An invite waiting because of
 * Junk or the Screener is added now: answering is the person acting on it.
 */
export function respondToInvite(
  db: MailDatabase,
  accountId: string,
  messageId: string,
  response: InviteResponse,
  from: { name: string; email: string },
  comment?: string,
): { event: CalendarEvent; mail: ItipMail | null } {
  const rowId = rowIdOf(messageId)
  const row = rowId === null ? null : messageRow(db, accountId, rowId)
  if (!row) throw new Error('Message not found')
  const itip = itipOf(invitesOfRow(db, row.id))
  if (!itip || itip.method !== 'REQUEST') throw new Error('This message has no invitation to answer')
  const selves = [...new Set([lower(from.email), ...selfAddresses(db, accountId)])]
  const invite = { kind: 'message' as const, accountId, messageId: uiMessageId(row) }
  const answered = db.transaction(() => {
    const events = [...itip.events].sort((a, b) => (a.recurrenceId == null ? 0 : 1) - (b.recurrenceId == null ? 0 : 1))
    const out: CalendarEvent[] = []
    for (const ev of events) {
      let applied = applyRequest(db, accountId, ev, selves, invite, response)
      if (applied === 'stale') {
        // An older copy of the invite: answer the event as it stands now.
        const current = eventByUid(db, ev.uid, ev.recurrenceId ?? undefined)!
        const attendees = current.attendees.some((a) => a.self) ? current.attendees.map((a) => (a.self ? { ...a, partstat: response } : a)) : [...current.attendees, { email: selves[0]!, partstat: response, self: true }]
        applied = saveEvent(db, { id: current.id, title: current.title, startAt: current.startAt, endAt: current.endAt, attendees })
      }
      if (applied === 'ignored') throw new Error('This invitation doesn’t match the event in your calendar')
      out.push(applied)
    }
    setState(db, row.id, 'applied')
    return out
  })()
  const event = answered[0]!
  if (!event.organizer?.email) return { event, mail: null }

  const self = (e: CalendarEvent): Attendee => {
    const mine = e.attendees.find((a) => a.self)
    return { email: mine?.email ?? from.email, name: mine?.name ?? from.name, partstat: response }
  }
  // RFC 5546 REPLY: our attendee line only, with the UID and SEQUENCE we're answering.
  const ics = writeCalendar(
    'REPLY',
    answered.map((e) => vevent(e, { attendees: [self(e)], description: null, alarms: undefined, status: undefined, recurrence: null, exdates: [], ...(comment?.trim() ? { comment: comment.trim() } : {}) })),
  )
  const label = RESPONSE_LABEL[response]
  const body = [`${from.name || from.email} has ${label.verb} this invitation.`, '', `**${event.title}**`, whenText(event), ...(comment?.trim() ? ['', comment.trim()] : [])].join('\n')
  const references = row.message_id ? replyReferences(JSON.parse(row.references_json) as string[], row.message_id) : undefined
  return {
    event,
    mail: {
      mail: { to: [event.organizer.email], cc: [], bcc: [], subject: `${label.subject}: ${event.title}`, body },
      calendar: { method: 'REPLY', ics, attach: false },
      ...(row.message_id && references ? { reply: { inReplyTo: row.message_id, references } } : {}),
    },
  }
}

/**
 * The REQUEST or CANCEL for an event Jefi organizes, to every attendee but us. A series goes with
 * its exceptions; an exception alone goes as that occurrence (RECURRENCE-ID). SEQUENCE is the
 * stored one: saveEvent already raised it for the change being announced. A CANCEL marks the event
 * cancelled first (raising SEQUENCE), so the UI can still delete it afterwards.
 */
export function eventInvites(db: MailDatabase, eventId: string, kind: 'request' | 'cancel', from: { name: string; email: string }): { event: CalendarEvent; mail: ItipMail } {
  let event = getEvent(db, eventId)
  if (!event) throw new Error('Event not found')
  const self = lower(from.email)
  if (event.organizer && lower(event.organizer.email) !== self) throw new Error('Only the organizer can send invitations for this event')
  const recipients = event.attendees.filter((a) => lower(a.email) !== self && !a.self)
  if (!recipients.length) throw new Error('This event has no one to invite')
  if (!event.organizer) event = saveEvent(db, { id: event.id, title: event.title, startAt: event.startAt, endAt: event.endAt, organizer: { email: from.email, name: from.name } })
  if (kind === 'cancel' && event.status !== 'cancelled') event = saveEvent(db, { id: event.id, title: event.title, startAt: event.startAt, endAt: event.endAt, status: 'cancelled' })

  const attendees = event.attendees.map(({ self: _, ...a }) => ({ ...a, rsvp: kind === 'request' && lower(a.email) !== self ? true : a.rsvp }))
  const exceptions = event.recurrence
    ? (db.query('SELECT id FROM events WHERE recurring_master_id = ? ORDER BY recurrence_id').all(event.id) as Array<{ id: string }>).map((r) => getEvent(db, r.id)!)
    : []
  // Most calendar apps ignore URL, so a meeting link also stands in as the place when there's none.
  const place = (e: CalendarEvent) => (!e.location && e.url && meetingProvider(e.url) ? { location: e.url } : {})
  const ics = writeCalendar(
    kind === 'request' ? 'REQUEST' : 'CANCEL',
    [event, ...(kind === 'request' ? exceptions : [])].map((e) => vevent(e, { attendees: e === event ? attendees : e.attendees.map(({ self: _, ...a }) => a), ...place(e) })),
  )
  const meeting = event.url ? meetingProvider(event.url) : null

  const guests = recipients.map((a) => a.name || a.email).join(', ')
  const lines =
    kind === 'request'
      ? [
          `**${event.title}**`,
          '',
          `When: ${whenText(event)}`,
          ...(event.recurrence ? [`Repeats: ${event.recurrence}`] : []),
          ...(event.location ? [`Where: ${event.location}`] : []),
          ...(event.url ? [`${meeting ? `Join ${meeting.label}` : 'Link'}: ${event.url}`] : []),
          `Organizer: ${personText(event.organizer!)}`,
          `Guests: ${guests}`,
          ...(event.description ? ['', event.description] : []),
          '',
          'Your calendar app can add this invitation and send your answer.',
        ]
      : [`**${event.title}** has been cancelled.`, '', `It was: ${whenText(event)}`, `Organizer: ${personText(event.organizer!)}`]
  const subject = kind === 'cancel' ? `Cancelled: ${event.title}` : event.sequence > 0 ? `Updated invitation: ${event.title}` : `Invitation: ${event.title}`
  return {
    event,
    mail: {
      mail: { to: recipients.map((a) => a.email), cc: [], bcc: [], subject, body: lines.join('\n') },
      calendar: { method: kind === 'request' ? 'REQUEST' : 'CANCEL', ics, attach: true },
    },
  }
}
