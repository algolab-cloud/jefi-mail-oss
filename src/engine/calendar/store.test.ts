import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS, migrate, openDatabase, type MailDatabase } from '../db'
import { ensureAccount } from '../mail-store'
import {
  LOCAL_CALENDAR_ID,
  createLocalCalendar,
  deleteCalendar,
  deleteEvent,
  eventByUid,
  eventLinks,
  eventsForThread,
  getEvent,
  linkEvent,
  listCalendars,
  listEvents,
  saveEvent,
  updateCalendar,
} from './store'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const dbs: MailDatabase[] = []
afterEach(() => {
  while (dbs.length) dbs.pop()!.close()
})
const fresh = () => {
  const db = openDatabase(':memory:')
  dbs.push(db)
  return db
}

/** A stored message in a thread; returns its row id. */
function mail(db: MailDatabase, accountId: string, n: number, opts: { thread?: string | null; subject?: string; date?: number } = {}) {
  ensureAccount(db, accountId, `${accountId}@example.com`)
  db.run("INSERT INTO messages (account_id, message_id, thread_id, subject, from_name, from_email, date) VALUES (?, ?, ?, ?, 'Ada Lovelace', 'ada@example.com', ?)", [
    accountId,
    `<m${n}@example.com>`,
    opts.thread === undefined ? 't1' : opts.thread,
    opts.subject ?? `Subject ${n}`,
    opts.date ?? Date.UTC(2026, 0, n),
  ])
  return (db.query('SELECT last_insert_rowid() id').get() as { id: number }).id
}

const at = (d: number, h = 9) => Date.UTC(2026, 0, d, h)
const range = (db: MailDatabase, from = at(1, 0), to = at(31, 0), ids?: string[]) => listEvents(db, from, to, ids).map((o) => [o.title, new Date(o.startAt).toISOString().slice(5, 16)])

test('a fresh database has one local calendar, the default', () => {
  const db = fresh()
  expect(listCalendars(db).map((c) => [c.id, c.name, c.source, c.isDefault, c.canWrite, c.hidden])).toEqual([[LOCAL_CALENDAR_ID, 'Personal', 'local', true, true, false]])
})

test('migrating an existing mail database keeps its mail and adds the default calendar', () => {
  const db = new Database(':memory:', { strict: true })
  dbs.push(db)
  migrate(db, MIGRATIONS.slice(0, 16))
  const id = mail(db, 'a', 1)
  expect(migrate(db)).toBe(MIGRATIONS.length)
  expect(db.query('SELECT subject FROM messages WHERE id = ?').get(id)).toEqual({ subject: 'Subject 1' })
  expect(listCalendars(db).map((c) => c.id)).toEqual([LOCAL_CALENDAR_ID])
  expect(db.query('SELECT created_at > 1700000000000 ok FROM calendars').get()).toEqual({ ok: 1 })
})

test('calendars: several local ones, one default, hidden ones left out of listings unless asked for', () => {
  const db = fresh()
  const work = createLocalCalendar(db, { name: ' Work ', color: '#f60' })
  expect(work.name).toBe('Work')
  expect(() => createLocalCalendar(db, { name: ' ', color: '#000' })).toThrow('Name the calendar')
  updateCalendar(db, work.id, { isDefault: true })
  expect(listCalendars(db).map((c) => [c.name, c.isDefault])).toEqual([['Work', true], ['Personal', false]])

  // New events go to the default calendar.
  const event = saveEvent(db, { title: 'Standup', startAt: at(5), endAt: at(5) + HOUR })
  expect(event.calendarId).toBe(work.id)
  updateCalendar(db, work.id, { hidden: true })
  expect(range(db)).toEqual([])
  expect(range(db, undefined, undefined, [work.id])).toEqual([['Standup', '01-05T09:00']])

  // Deleting the default takes its events and moves the default; the last local calendar stays.
  deleteCalendar(db, work.id)
  expect(getEvent(db, event.id)).toBeNull()
  expect(listCalendars(db).map((c) => [c.name, c.isDefault])).toEqual([['Personal', true]])
  expect(() => deleteCalendar(db, LOCAL_CALENDAR_ID)).toThrow('at least one calendar')
})

test('a subscription calendar is read-only', () => {
  const db = fresh()
  db.run("INSERT INTO calendars (id, source, name, color, can_write, url, created_at, updated_at) VALUES ('sub', 'subscription', 'Holidays', '#0a0', 0, 'https://example.com/h.ics', 1, 1)")
  expect(() => saveEvent(db, { calendarId: 'sub', title: 'Mine', startAt: at(2), endAt: at(2) + HOUR })).toThrow('read-only')
  expect(() => updateCalendar(db, 'sub', { isDefault: true })).toThrow()
  expect(listCalendars(db).map((c) => [c.name, c.url])).toEqual([['Personal', null], ['Holidays', 'https://example.com/h.ics']])
})

test('events: create, update and delete; SEQUENCE goes up only for changes attendees must hear about', () => {
  const db = fresh()
  const created = saveEvent(db, { title: ' Lunch ', startAt: at(3, 12), endAt: at(3, 13), timeZone: 'Europe/Paris', location: 'Café', attendees: [{ email: 'b@example.com', partstat: 'needs-action', rsvp: true }] })
  expect(created).toMatchObject({ title: 'Lunch', sequence: 0, timeZone: 'Europe/Paris', location: 'Café', status: 'confirmed', recurrence: null, invite: null, accountId: null })
  expect(created.uid).toEndWith('@jefi')
  expect(created.attendees).toEqual([{ email: 'b@example.com', partstat: 'needs-action', rsvp: true }])

  const renamed = saveEvent(db, { id: created.id, title: 'Team lunch', startAt: created.startAt, endAt: created.endAt })
  expect([renamed.title, renamed.sequence, renamed.location, renamed.timeZone]).toEqual(['Team lunch', 0, 'Café', 'Europe/Paris'])
  const moved = saveEvent(db, { id: created.id, title: 'Team lunch', startAt: at(4, 12), endAt: at(4, 13) })
  expect(moved.sequence).toBe(1)
  expect(moved.uid).toBe(created.uid)
  expect(saveEvent(db, { id: created.id, title: 'Team lunch', startAt: at(4, 12), endAt: at(4, 13), sequence: 7 }).sequence).toBe(7)
  // A new meeting link is news for the guests too.
  expect(saveEvent(db, { id: created.id, title: 'Team lunch', startAt: at(4, 12), endAt: at(4, 13), url: 'https://meet.google.com/abc-defg-hij' }).sequence).toBe(8)

  expect(range(db)).toEqual([['Team lunch', '01-04T12:00']])
  expect(deleteEvent(db, created.id)).toBe(true)
  expect(deleteEvent(db, created.id)).toBe(false)
  expect(range(db)).toEqual([])
})

test('events: bad input is refused with a message; all-day events snap to whole days', () => {
  const db = fresh()
  expect(() => saveEvent(db, { title: 'x', startAt: at(2), endAt: at(1) })).toThrow('end before it starts')
  expect(() => saveEvent(db, { title: 'x', startAt: at(2), endAt: at(2), timeZone: 'Mars/Olympus' })).toThrow('Unknown time zone')
  expect(() => saveEvent(db, { title: 'x', startAt: at(2), endAt: at(2), recurrence: 'FREQ=HOURLY' })).toThrow('Unsupported')
  expect(() => saveEvent(db, { id: 'nope', title: 'x', startAt: at(2), endAt: at(2) })).toThrow('Event not found')

  const trip = saveEvent(db, { title: 'Trip', allDay: true, startAt: at(10, 15), endAt: at(12, 3), timeZone: 'Asia/Tokyo' })
  expect([trip.startAt, trip.endAt, trip.timeZone]).toEqual([Date.UTC(2026, 0, 10), Date.UTC(2026, 0, 13), null])
  // A zero-length timed event at the range start is in the range.
  saveEvent(db, { title: 'Reminder', startAt: at(1, 0), endAt: at(1, 0) })
  expect(range(db).map(([title]) => title)).toEqual(['Reminder', 'Trip'])
})

test('series: editing one occurrence makes an exception with the series UID', () => {
  const db = fresh()
  const series = saveEvent(db, { title: 'Standup', startAt: at(5), endAt: at(5) + HOUR / 4, timeZone: 'UTC', recurrence: 'RRULE:FREQ=DAILY;COUNT=4' })
  expect(series.recurrence).toBe('FREQ=DAILY;COUNT=4')
  const listed = listEvents(db, at(1, 0), at(31, 0))
  expect(listed.map((o) => [o.key, o.recurring, o.occurrenceStart])).toEqual([0, 1, 2, 3].map((i) => [`${series.id}@${at(5 + i)}`, true, at(5 + i)]))

  const exception = saveEvent(db, { id: series.id, title: 'Standup (late)', startAt: at(6, 11), endAt: at(6, 11) + HOUR / 4 }, { scope: 'this', occurrenceStart: at(6) })
  expect(exception).toMatchObject({ uid: series.uid, recurringMasterId: series.id, recurrenceId: at(6), recurrence: null, sequence: series.sequence + 1 })
  expect(getEvent(db, series.id)!.exdates).toEqual([at(6)])
  expect(range(db)).toEqual([['Standup', '01-05T09:00'], ['Standup (late)', '01-06T11:00'], ['Standup', '01-07T09:00'], ['Standup', '01-08T09:00']])
  expect(eventByUid(db, series.uid)!.id).toBe(series.id)
  expect(eventByUid(db, series.uid, at(6))!.id).toBe(exception.id)
  // Editing the exception again edits it in place.
  saveEvent(db, { id: exception.id, title: 'Standup (later)', startAt: at(6, 12), endAt: at(6, 12) + HOUR / 4 })
  expect(range(db)[1]).toEqual(['Standup (later)', '01-06T12:00'])
  // Without an occurrence a scoped edit can't be applied.
  expect(() => saveEvent(db, { id: series.id, title: 'x', startAt: at(5), endAt: at(5) }, { scope: 'this' })).toThrow('Say which occurrence')
})

test('events move between calendars: a series with its exceptions, never one occurrence alone', () => {
  const db = fresh()
  const work = createLocalCalendar(db, { name: 'Work', color: '#3E63DD' })
  const single = saveEvent(db, { title: 'Dentist', startAt: at(3), endAt: at(3) + HOUR })
  const moved = saveEvent(db, { id: single.id, calendarId: work.id, title: 'Dentist', startAt: at(3), endAt: at(3) + HOUR })
  expect([moved.calendarId, moved.sequence]).toEqual([work.id, single.sequence])
  expect(range(db, at(1, 0), at(31, 0), [work.id])).toEqual([['Dentist', '01-03T09:00']])

  const series = saveEvent(db, { title: 'Standup', startAt: at(5), endAt: at(5) + HOUR / 4, timeZone: 'UTC', recurrence: 'FREQ=DAILY;COUNT=3' })
  const exception = saveEvent(db, { id: series.id, title: 'Standup (late)', startAt: at(6, 11), endAt: at(6, 11) + HOUR / 4 }, { scope: 'this', occurrenceStart: at(6) })
  expect(() => saveEvent(db, { id: exception.id, calendarId: work.id, title: 'x', startAt: at(6, 11), endAt: at(6, 12) })).toThrow('whole series')
  expect(() => saveEvent(db, { id: series.id, calendarId: work.id, title: 'x', startAt: at(7), endAt: at(7) + HOUR }, { scope: 'this', occurrenceStart: at(7) })).toThrow('whole series')
  saveEvent(db, { id: series.id, calendarId: work.id, title: 'Standup', startAt: at(7), endAt: at(7) + HOUR / 4 }, { scope: 'all', occurrenceStart: at(7) })
  expect(getEvent(db, exception.id)!.calendarId).toBe(work.id)
  expect(range(db, at(1, 0), at(31, 0), [LOCAL_CALENDAR_ID])).toEqual([])
  expect(range(db, at(1, 0), at(31, 0), [work.id]).map(([title]) => title)).toEqual(['Dentist', 'Standup', 'Standup (late)', 'Standup'])
})

test('series: this-and-following splits it into a new series that keeps the remaining COUNT', () => {
  const db = fresh()
  const series = saveEvent(db, { title: 'Gym', startAt: at(5, 7), endAt: at(5, 8), timeZone: 'UTC', recurrence: 'FREQ=DAILY;COUNT=5' })
  saveEvent(db, { id: series.id, title: 'Gym (moved)', startAt: at(9, 7), endAt: at(9, 8) }, { scope: 'this', occurrenceStart: at(9, 7) })
  const next = saveEvent(db, { id: series.id, title: 'Swim', startAt: at(7, 18), endAt: at(7, 19) }, { scope: 'following', occurrenceStart: at(7, 7) })
  expect(next.id).not.toBe(series.id)
  expect(next.uid).not.toBe(series.uid)
  expect(next.recurrence).toBe('FREQ=DAILY;COUNT=3')
  expect(getEvent(db, series.id)!.recurrence).toBe('FREQ=DAILY;UNTIL=20260107T065959Z')
  // The exception on the 9th belonged to the part that was replaced.
  expect(range(db)).toEqual([['Gym', '01-05T07:00'], ['Gym', '01-06T07:00'], ['Swim', '01-07T18:00'], ['Swim', '01-08T18:00'], ['Swim', '01-09T18:00']])
})

test('series: editing all through an occurrence moves the whole series by the same amount', () => {
  const db = fresh()
  const series = saveEvent(db, { title: 'Review', startAt: at(5, 9), endAt: at(5, 10), timeZone: 'UTC', recurrence: 'FREQ=WEEKLY;COUNT=3' })
  deleteEvent(db, series.id, 'this', at(12, 9))
  saveEvent(db, { id: series.id, title: 'Review', startAt: at(19, 14), endAt: at(19, 16) }, { scope: 'all', occurrenceStart: at(19, 9) })
  expect(range(db)).toEqual([['Review', '01-05T14:00'], ['Review', '01-19T14:00']])
  expect(listEvents(db, at(1, 0), at(31, 0))[0]!.endAt - at(5, 14)).toBe(2 * HOUR)
})

test('series: deleting this, following or all of it', () => {
  const db = fresh()
  const series = saveEvent(db, { title: 'Walk', startAt: at(5), endAt: at(5) + HOUR, timeZone: 'UTC', recurrence: 'FREQ=DAILY' })
  expect(() => deleteEvent(db, series.id, 'this')).toThrow('Say which occurrence')
  deleteEvent(db, series.id, 'this', at(6))
  const exception = saveEvent(db, { id: series.id, title: 'Long walk', startAt: at(8), endAt: at(8) + 3 * HOUR }, { scope: 'this', occurrenceStart: at(8) })
  expect(range(db, at(5, 0), at(10, 0)).map(([t, d]) => `${t} ${d}`)).toEqual(['Walk 01-05T09:00', 'Walk 01-07T09:00', 'Long walk 01-08T09:00', 'Walk 01-09T09:00'])
  // Deleting the exception with 'this' leaves that occurrence out; 'following' through it truncates the series.
  deleteEvent(db, exception.id, 'this')
  expect(range(db, at(7, 0), at(10, 0)).map(([t]) => t)).toEqual(['Walk', 'Walk'])
  deleteEvent(db, series.id, 'following', at(9))
  expect(range(db, at(1, 0), at(31, 0)).map(([, d]) => d)).toEqual(['01-05T09:00', '01-07T09:00'])
  deleteEvent(db, series.id, 'all')
  expect(db.query('SELECT count(*) n FROM events').get()).toEqual({ n: 0 })
})

test('an invite keeps the organizer UID: saving it again updates the same event, with the newest invite linked', () => {
  const db = fresh()
  const first = mail(db, 'a', 1, { subject: 'Invitation: Kickoff' })
  const second = mail(db, 'a', 2, { subject: 'Updated invitation: Kickoff' })
  const fromInvite = (row: number, startAt: number, sequence: number) =>
    saveEvent(db, {
      uid: 'kickoff-123@organizer.example',
      sequence,
      accountId: 'a',
      title: 'Kickoff',
      startAt,
      endAt: startAt + HOUR,
      timeZone: 'UTC',
      organizer: { email: 'boss@example.com', name: 'Boss' },
      attendees: [{ email: 'a@example.com', partstat: 'needs-action', rsvp: true }],
      invite: { kind: 'message', accountId: 'a', messageId: `a:t1-${row}` },
    })
  const created = fromInvite(first, at(20), 0)
  expect(created).toMatchObject({ uid: 'kickoff-123@organizer.example', sequence: 0, accountId: 'a', organizer: { email: 'boss@example.com', name: 'Boss' } })
  expect(created.invite).toMatchObject({ role: 'invite', live: true, target: { kind: 'message', accountId: 'a', messageId: `a:t1-${first}` }, snapshot: { subject: 'Invitation: Kickoff' } })

  const updated = fromInvite(second, at(21), 1)
  expect(updated.id).toBe(created.id)
  expect([updated.startAt, updated.sequence]).toEqual([at(21), 1])
  expect(updated.invite!.snapshot.subject).toBe('Updated invitation: Kickoff')
  expect(eventLinks(db, created.id).map((l) => l.role)).toEqual(['invite'])
  expect(eventByUid(db, 'kickoff-123@organizer.example')!.id).toBe(created.id)
  // Accepting is an attendee change: no new SEQUENCE (that's the organizer's).
  const accepted = saveEvent(db, { id: created.id, title: 'Kickoff', startAt: at(21), endAt: at(21) + HOUR, attendees: [{ email: 'a@example.com', partstat: 'accepted' }] })
  expect(accepted.sequence).toBe(1)
  // A cancellation keeps the row, and its UID, but drops it from listings.
  saveEvent(db, { id: created.id, title: 'Kickoff', startAt: at(21), endAt: at(21) + HOUR, status: 'cancelled', sequence: 2 })
  expect(range(db)).toEqual([])
  expect(eventByUid(db, 'kickoff-123@organizer.example')!.status).toBe('cancelled')
})

test('links to mail snapshot it, and follow it by Message-ID when the thread id changes', () => {
  const db = fresh()
  const one = mail(db, 'a', 1, { subject: 'Dinner?' })
  mail(db, 'a', 2, { subject: 'Re: Dinner?', date: Date.UTC(2026, 0, 3) })
  const event = saveEvent(db, { title: 'Dinner', startAt: at(9, 19), endAt: at(9, 21), links: [{ kind: 'thread', accountId: 'a', threadId: 'a:t1' }] })
  const [link] = eventLinks(db, event.id)
  expect(link).toMatchObject({ role: 'related', live: true, target: { kind: 'thread', accountId: 'a', threadId: 'a:t1' }, snapshot: { subject: 'Dinner?', from: { name: 'Ada Lovelace', email: 'ada@example.com' }, date: Date.UTC(2026, 0, 3) } })
  expect(() => linkEvent(db, event.id, { kind: 'thread', accountId: 'a', threadId: 'a:nope' })).toThrow('Conversation not found')
  // Linking the same target again doesn't add a second link.
  linkEvent(db, event.id, { kind: 'thread', accountId: 'a', threadId: 'a:t1' })
  expect(eventLinks(db, event.id).length).toBe(1)

  // A link to one message finds the event from its conversation too.
  const other = saveEvent(db, { title: 'Other', startAt: at(10), endAt: at(10), links: [{ kind: 'message', accountId: 'a', messageId: `a:t1-${one}` }] })
  expect(eventsForThread(db, 'a', 'a:t1').map((e) => e.id)).toEqual([event.id, other.id])
  expect(eventsForThread(db, 'b', 'a:t1')).toEqual([])

  // Re-threaded: the old UI ids are stale, the headers still find the mail.
  db.run("UPDATE messages SET thread_id = 't9'")
  expect(eventsForThread(db, 'a', 'a:t9').map((e) => e.id)).toEqual([event.id, other.id])
  expect(eventLinks(db, event.id)[0]).toMatchObject({ live: true, target: { threadId: 'a:t9' } })
  expect(eventLinks(db, other.id)[0]).toMatchObject({ live: true, target: { messageId: `a:t9-${one}` } })

  // Gone: the snapshot is what's left.
  db.run('DELETE FROM messages')
  expect(eventLinks(db, event.id)[0]).toMatchObject({ live: false, snapshot: { subject: 'Dinner?' } })
})
