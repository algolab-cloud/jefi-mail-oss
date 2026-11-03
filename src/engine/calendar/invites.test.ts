import { afterEach, describe, expect, test } from 'bun:test'
import { parseIcs } from '../../detect/ics'
import { openDatabase, type MailDatabase } from '../db'
import { ensureAccount } from '../mail-store'
import { setScreener, setVerdict } from '../screener'
import { uiThreadId } from '../threading'
import { applyNewInvites, eventInvites, inviteView, itipOf, pendingInvites, respondToInvite } from './invites'
import { createLocalCalendar, eventByUid, getEvent, listEvents, saveEvent } from './store'

// Received invites into the calendar (REQUEST / CANCEL / REPLY with SEQUENCE ordering), answering
// them, and the iTIP content of what Jefi sends. The mail side (MIME, SMTP, outbox) is in
// invites-send.test.ts.

const dbs: MailDatabase[] = []
afterEach(() => {
  while (dbs.length) dbs.pop()!.close()
})

const ME = 'me@example.com'
const ACCOUNT = 'acct'
const fresh = () => {
  const db = openDatabase(':memory:')
  dbs.push(db)
  ensureAccount(db, ACCOUNT, ME)
  return db
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

type IcsOpts = {
  method?: string
  uid?: string
  seq?: number
  start?: string
  end?: string
  summary?: string
  rrule?: string
  rid?: string
  organizer?: string
  attendees?: string[]
  extra?: string[]
}

const ics = (o: IcsOpts = {}) =>
  [
    'BEGIN:VCALENDAR',
    'PRODID:-//Example//Calendar//EN',
    'VERSION:2.0',
    ...(o.method === undefined ? ['METHOD:REQUEST'] : o.method ? [`METHOD:${o.method}`] : []),
    'BEGIN:VEVENT',
    `UID:${o.uid ?? 'sync-1@org.example'}`,
    `SEQUENCE:${o.seq ?? 0}`,
    'DTSTAMP:20260301T090000Z',
    `DTSTART:${o.start ?? '20260310T150000Z'}`,
    `DTEND:${o.end ?? '20260310T160000Z'}`,
    ...(o.rrule ? [`RRULE:${o.rrule}`] : []),
    ...(o.rid ? [`RECURRENCE-ID:${o.rid}`] : []),
    `SUMMARY:${o.summary ?? 'Team sync'}`,
    `ORGANIZER;CN=Boss:mailto:${o.organizer ?? 'boss@org.example'}`,
    ...(o.attendees ?? [`ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me:mailto:${ME}`, 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@org.example']),
    ...(o.extra ?? []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

let n = 0
/** A received message with calendar parts; returns its UI message id. */
function receive(db: MailDatabase, parts: Array<{ method?: string | null; ics: string; filename?: string }>, opts: { from?: string; date?: number; junk?: boolean } = {}) {
  n++
  db.run('INSERT INTO messages (account_id, message_id, thread_id, subject, from_name, from_email, date) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    ACCOUNT,
    `<inv${n}@org.example>`,
    `t${n}`,
    `Invitation ${n}`,
    'Boss',
    opts.from ?? 'boss@org.example',
    opts.date ?? Date.UTC(2026, 2, 1) + n * 1000,
  ])
  const id = (db.query('SELECT last_insert_rowid() id').get() as { id: number }).id
  parts.forEach((p, i) => db.run('INSERT INTO invites (message_id, idx, method, filename, ics) VALUES (?, ?, ?, ?, ?)', [id, i, p.method === undefined ? 'REQUEST' : p.method, p.filename ?? null, p.ics]))
  if (opts.junk) {
    db.run("INSERT OR IGNORE INTO mailboxes (account_id, path, special_use) VALUES (?, 'Junk', '\\Junk')", [ACCOUNT])
    const box = (db.query("SELECT id FROM mailboxes WHERE path = 'Junk'").get() as { id: number }).id
    db.run('INSERT INTO message_mailboxes (mailbox_id, uid, message_id) VALUES (?, ?, ?)', [box, n, id])
  }
  return `${uiThreadId(ACCOUNT, `t${n}`, id)}-${id}`
}

const request = (db: MailDatabase, o: IcsOpts = {}, opts: Parameters<typeof receive>[2] = {}) => receive(db, [{ method: o.method ?? 'REQUEST', ics: ics(o) }], opts)
/** The test's database, for `me`. */
let current: MailDatabase | null = null
/** Our attendee line on the event with this UID. */
const me = (uid = 'sync-1@org.example') => eventByUid(current!, uid)?.attendees.find((a) => a.self)
const MARCH = [Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1)] as const
const listed = (db: MailDatabase) => listEvents(db, ...MARCH).map((o) => [o.title, new Date(o.startAt).toISOString().slice(5, 16)])
const FROM = { name: 'Mara Lin', email: ME }

describe('received invites', () => {
  test('a REQUEST adds the event to the default calendar, waiting for our answer', () => {
    const db = (current = fresh())
    const messageId = request(db)
    expect(applyNewInvites(db, ACCOUNT)).toEqual(['local'])
    const event = eventByUid(db, 'sync-1@org.example')!
    expect(event).toMatchObject({ calendarId: 'local', title: 'Team sync', sequence: 0, accountId: ACCOUNT, organizer: { email: 'boss@org.example', name: 'Boss' }, startAt: Date.UTC(2026, 2, 10, 15), status: 'confirmed' })
    expect(event.attendees).toEqual([
      { email: ME, name: 'Me', partstat: 'needs-action', rsvp: true, self: true },
      { email: 'boss@org.example', partstat: 'accepted' },
    ])
    expect(event.invite).toMatchObject({ role: 'invite', live: true, target: { kind: 'message', messageId } })
    expect(inviteView(db, ACCOUNT, messageId)).toMatchObject({ method: 'REQUEST', state: 'applied', eventId: event.id, response: 'needs-action', cancelled: false, outdated: false })
    // Applied once: a second pass has nothing new.
    expect(applyNewInvites(db, ACCOUNT)).toEqual([])
  })

  test('an invite’s alerts come with a new event; an update leaves the person’s own choice alone', () => {
    const db = (current = fresh())
    const alarm = (trigger: string) => ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:${trigger}`, 'END:VALARM']
    request(db, { extra: [...alarm('-PT15M'), ...alarm('-P1D')] })
    applyNewInvites(db, ACCOUNT)
    const event = eventByUid(db, 'sync-1@org.example')!
    expect(event.alarms).toEqual([15, 1440])
    saveEvent(db, { id: event.id, title: event.title, startAt: event.startAt, endAt: event.endAt, alarms: [] })
    request(db, { seq: 1, extra: alarm('-PT5M') })
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'sync-1@org.example')!.alarms).toEqual([])
    // No VALARM: the person's default applies.
    request(db, { uid: 'plain@org.example' })
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'plain@org.example')!.alarms).toBeNull()
  })

  test('a newer SEQUENCE updates it and asks again; an older one changes nothing; the same one keeps our answer', () => {
    const db = (current = fresh())
    const first = request(db)
    applyNewInvites(db, ACCOUNT)
    respondToInvite(db, ACCOUNT, first, 'accepted', FROM)
    expect(me()!.partstat).toBe('accepted')

    // Same revision again (a resend): our answer stays.
    request(db, { summary: 'Team sync (agenda)' })
    applyNewInvites(db, ACCOUNT)
    expect([eventByUid(db, 'sync-1@org.example')!.title, me()!.partstat]).toEqual(['Team sync (agenda)', 'accepted'])

    const moved = request(db, { seq: 2, start: '20260311T150000Z', end: '20260311T160000Z' })
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'sync-1@org.example')).toMatchObject({ sequence: 2, startAt: Date.UTC(2026, 2, 11, 15) })
    expect(me()!.partstat).toBe('needs-action')

    // Seq 1 arrives late: stale.
    const late = request(db, { seq: 1, start: '20260312T150000Z', end: '20260312T160000Z' })
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'sync-1@org.example')).toMatchObject({ sequence: 2, startAt: Date.UTC(2026, 2, 11, 15) })
    expect(inviteView(db, ACCOUNT, late)).toMatchObject({ state: 'stale', outdated: true })
    expect(inviteView(db, ACCOUNT, moved)).toMatchObject({ state: 'applied', outdated: false })
  })

  test('an update lands in the calendar the event already lives in', () => {
    const db = (current = fresh())
    const work = createLocalCalendar(db, { name: 'Work', color: '#06f' })
    saveEvent(db, { calendarId: work.id, uid: 'sync-1@org.example', title: 'Team sync', startAt: Date.UTC(2026, 2, 10, 15), endAt: Date.UTC(2026, 2, 10, 16), organizer: { email: 'boss@org.example' } })
    request(db, { seq: 1, summary: 'Team sync v2' })
    expect(applyNewInvites(db, ACCOUNT)).toEqual([work.id])
    expect(eventByUid(db, 'sync-1@org.example')).toMatchObject({ calendarId: work.id, title: 'Team sync v2', sequence: 1 })
  })

  test('a CANCEL marks the event cancelled (hidden); an older CANCEL or another organizer is ignored', () => {
    const db = (current = fresh())
    request(db, { seq: 3 })
    applyNewInvites(db, ACCOUNT)
    const spoof = receive(db, [{ method: 'CANCEL', ics: ics({ method: 'CANCEL', seq: 4, organizer: 'mallory@evil.example' }) }], { from: 'mallory@evil.example' })
    const old = receive(db, [{ method: 'CANCEL', ics: ics({ method: 'CANCEL', seq: 2 }) }])
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'sync-1@org.example')!.status).toBe('confirmed')
    expect([inviteView(db, ACCOUNT, spoof)!.state, inviteView(db, ACCOUNT, old)!.state]).toEqual(['ignored', 'stale'])

    const cancel = receive(db, [{ method: 'CANCEL', ics: ics({ method: 'CANCEL', seq: 4, extra: ['STATUS:CANCELLED'] }) }])
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'sync-1@org.example')).toMatchObject({ status: 'cancelled', sequence: 4 })
    expect(listed(db)).toEqual([])
    expect(inviteView(db, ACCOUNT, cancel)).toMatchObject({ method: 'CANCEL', cancelled: true })
  })

  test('a CANCEL applied before its invitation keeps the meeting off', () => {
    // A first sync (or a Mac back from a trip) fetches the newest mail first, so the cancellation
    // can be applied before the invitation it cancels.
    const db = (current = fresh())
    const cancel = receive(db, [{ method: 'CANCEL', ics: ics({ method: 'CANCEL', seq: 1, extra: ['STATUS:CANCELLED'] }) }])
    applyNewInvites(db, ACCOUNT)
    const invitation = request(db)
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'sync-1@org.example')).toMatchObject({ status: 'cancelled', sequence: 1, title: 'Team sync' })
    expect(listed(db)).toEqual([])
    expect(pendingInvites(db, Date.UTC(2026, 2, 1))).toEqual([])
    expect(inviteView(db, ACCOUNT, invitation)).toMatchObject({ method: 'REQUEST', state: 'stale', cancelled: true })
    expect(inviteView(db, ACCOUNT, cancel)).toMatchObject({ method: 'CANCEL', cancelled: true })
    // A newer revision from the organizer brings it back.
    request(db, { seq: 2, summary: 'Team sync, back on' })
    applyNewInvites(db, ACCOUNT)
    expect(listed(db)).toEqual([['Team sync, back on', '03-10T15:00']])
  })

  test('a cancellation from someone else, before the invitation, doesn’t block the real one', () => {
    const db = (current = fresh())
    receive(db, [{ method: 'CANCEL', ics: ics({ method: 'CANCEL', seq: 5, organizer: 'mallory@evil.example' }) }], { from: 'mallory@evil.example' })
    applyNewInvites(db, ACCOUNT)
    request(db)
    applyNewInvites(db, ACCOUNT)
    expect(eventByUid(db, 'sync-1@org.example')).toMatchObject({ status: 'confirmed', organizer: { email: 'boss@org.example' } })
    expect(listed(db)).toEqual([['Team sync', '03-10T15:00']])
  })

  test('a REPLY records the attendee’s answer on an event we organize, only from that attendee', () => {
    const db = (current = fresh())
    const ours = saveEvent(db, {
      uid: 'ours@jefi',
      accountId: ACCOUNT,
      title: 'Planning',
      startAt: Date.UTC(2026, 2, 12, 10),
      endAt: Date.UTC(2026, 2, 12, 11),
      organizer: { email: ME },
      attendees: [{ email: 'kenji@example.com', partstat: 'needs-action', rsvp: true }, { email: 'ada@example.com', partstat: 'needs-action' }],
    })
    const reply = (from: string, who: string, partstat: string, seq = 0) =>
      receive(db, [{ method: 'REPLY', ics: ics({ method: 'REPLY', uid: 'ours@jefi', seq, organizer: ME, attendees: [`ATTENDEE;PARTSTAT=${partstat}:mailto:${who}`] }) }], { from })
    const kenji = reply('kenji@example.com', 'kenji@example.com', 'ACCEPTED')
    reply('mallory@evil.example', 'ada@example.com', 'DECLINED')
    applyNewInvites(db, ACCOUNT)
    expect(getEvent(db, ours.id)!.attendees.map((a) => [a.email, a.partstat])).toEqual([['kenji@example.com', 'accepted'], ['ada@example.com', 'needs-action']])
    // A reply isn't a revision.
    expect(getEvent(db, ours.id)!.sequence).toBe(0)
    expect(inviteView(db, ACCOUNT, kenji)).toMatchObject({ method: 'REPLY', replyFrom: { email: 'kenji@example.com', partstat: 'accepted' } })
  })

  test('the inline part and its invite.ics copy are one invite', () => {
    const db = (current = fresh())
    const text = ics()
    const parts = [{ method: 'REQUEST', ics: text }, { method: 'PUBLISH', ics: text.replace('METHOD:REQUEST', 'METHOD:PUBLISH'), filename: 'invite.ics' }]
    expect(itipOf(parts)!.events.length).toBe(1)
    expect(itipOf(parts)!.method).toBe('REQUEST')
    receive(db, parts)
    applyNewInvites(db, ACCOUNT)
    expect((db.query('SELECT count(*) n FROM events').get() as { n: number }).n).toBe(1)
  })

  test('a changed or cancelled occurrence (RECURRENCE-ID) applies to that occurrence only', () => {
    const db = (current = fresh())
    request(db, { uid: 'weekly@org.example', seq: 1, start: '20260302T150000Z', end: '20260302T160000Z', rrule: 'FREQ=WEEKLY;COUNT=4', summary: 'Weekly' })
    applyNewInvites(db, ACCOUNT)
    const series = eventByUid(db, 'weekly@org.example')!
    // The 9 March one moves an hour later; the 16 March one is cancelled.
    request(db, { uid: 'weekly@org.example', seq: 1, rid: '20260309T150000Z', start: '20260309T160000Z', end: '20260309T170000Z', summary: 'Weekly (moved)' })
    receive(db, [{ method: 'CANCEL', ics: ics({ method: 'CANCEL', uid: 'weekly@org.example', seq: 1, rid: '20260316T150000Z', start: '20260316T150000Z', end: '20260316T160000Z' }) }])
    applyNewInvites(db, ACCOUNT)
    expect(listed(db)).toEqual([
      ['Weekly', '03-02T15:00'],
      ['Weekly (moved)', '03-09T16:00'],
      ['Weekly', '03-23T15:00'],
    ])
    const exception = eventByUid(db, 'weekly@org.example', Date.UTC(2026, 2, 9, 15))!
    expect(exception).toMatchObject({ recurringMasterId: series.id, sequence: 1 })
    // The organizer's revision of the series is untouched, so their next update still applies.
    expect(getEvent(db, series.id)!.sequence).toBe(1)
    request(db, { uid: 'weekly@org.example', seq: 2, start: '20260302T150000Z', end: '20260302T160000Z', rrule: 'FREQ=WEEKLY;COUNT=4', summary: 'Weekly v2' })
    applyNewInvites(db, ACCOUNT)
    expect(getEvent(db, series.id)).toMatchObject({ title: 'Weekly v2', sequence: 2 })
  })

  test('invites from Junk, blocked or screened senders wait for the person; answering adds them', () => {
    const db = (current = fresh())
    setVerdict(db, ACCOUNT, 'blocked@spam.example', 'block')
    const blocked = request(db, { uid: 'b@spam.example', organizer: 'blocked@spam.example' }, { from: 'blocked@spam.example' })
    const junk = request(db, { uid: 'j@org.example' }, { junk: true })
    setScreener(db, ACCOUNT, true)
    const screened = request(db, { uid: 's@new.example', organizer: 'new@new.example' }, { from: 'new@new.example', date: Date.now() })
    expect(applyNewInvites(db, ACCOUNT)).toEqual([])
    expect((db.query('SELECT count(*) n FROM events').get() as { n: number }).n).toBe(0)
    for (const id of [blocked, junk, screened]) expect(inviteView(db, ACCOUNT, id)).toMatchObject({ state: 'pending', eventId: null, response: null })

    const { event } = respondToInvite(db, ACCOUNT, junk, 'accepted', FROM)
    expect(event).toMatchObject({ uid: 'j@org.example', calendarId: 'local' })
    expect(inviteView(db, ACCOUNT, junk)).toMatchObject({ state: 'applied', response: 'accepted' })
  })

  test('our own copy of an invitation is not applied', () => {
    const db = (current = fresh())
    const own = request(db, { organizer: ME }, { from: ME })
    applyNewInvites(db, ACCOUNT)
    expect(inviteView(db, ACCOUNT, own)!.state).toBe('own')
    expect(eventByUid(db, 'sync-1@org.example')).toBeNull()
  })
})

describe('answering', () => {
  test('declining keeps the event but hides it, and the REPLY carries our PARTSTAT, UID and SEQUENCE', () => {
    const db = (current = fresh())
    const messageId = request(db, { seq: 5 })
    applyNewInvites(db, ACCOUNT)
    expect(listed(db).length).toBe(1)
    const { event, mail } = respondToInvite(db, ACCOUNT, messageId, 'declined', FROM, 'Travelling, sorry; next time')
    expect(listed(db)).toEqual([])
    expect(getEvent(db, event.id)!.attendees.find((a) => a.self)!.partstat).toBe('declined')
    expect(mail!.mail).toMatchObject({ to: ['boss@org.example'], subject: 'Declined: Team sync' })
    expect(mail!.reply).toEqual({ inReplyTo: `<inv${n}@org.example>`, references: [`<inv${n}@org.example>`] })
    expect(mail!.calendar).toMatchObject({ method: 'REPLY', attach: false })
    const parsed = parseIcs(mail!.calendar.ics)
    expect(parsed.method).toBe('REPLY')
    expect(parsed.events).toEqual([
      expect.objectContaining({ uid: 'sync-1@org.example', sequence: 5, comment: 'Travelling, sorry; next time', organizer: { name: 'Boss', email: 'boss@org.example' }, attendees: [{ name: 'Me', email: ME, partstat: 'DECLINED', role: 'REQ-PARTICIPANT' }] }),
    ])
    expect(mail!.calendar.ics).toMatch(/^DTSTAMP:\d{8}T\d{6}Z\r$/m)

    // Changing our mind shows it again.
    respondToInvite(db, ACCOUNT, messageId, 'tentative', FROM)
    expect(listed(db).length).toBe(1)
    expect(inviteView(db, ACCOUNT, messageId)!.response).toBe('tentative')
  })

  test('answering one occurrence sends its RECURRENCE-ID', () => {
    const db = (current = fresh())
    request(db, { uid: 'weekly@org.example', start: '20260302T150000Z', end: '20260302T160000Z', rrule: 'FREQ=WEEKLY;COUNT=4' })
    const one = request(db, { uid: 'weekly@org.example', rid: '20260309T150000Z', start: '20260309T160000Z', end: '20260309T170000Z' })
    applyNewInvites(db, ACCOUNT)
    const { mail } = respondToInvite(db, ACCOUNT, one, 'accepted', FROM)
    const [ev] = parseIcs(mail!.calendar.ics).events
    expect([ev!.recurrenceId, ev!.attendees[0]!.partstat]).toEqual([Date.UTC(2026, 2, 9, 15), 'ACCEPTED'])
  })

  test('a message without an invitation can’t be answered', () => {
    const db = (current = fresh())
    const reply = receive(db, [{ method: 'REPLY', ics: ics({ method: 'REPLY' }) }])
    expect(() => respondToInvite(db, ACCOUNT, reply, 'accepted', FROM)).toThrow('no invitation to answer')
  })
})

describe('sending invitations', () => {
  const planning = (db: MailDatabase, extra: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(db, {
      accountId: ACCOUNT,
      title: 'Planning, Q3; budget',
      startAt: Date.UTC(2026, 2, 12, 10),
      endAt: Date.UTC(2026, 2, 12, 11),
      timeZone: 'Europe/Berlin',
      location: 'Room 4',
      attendees: [{ email: 'kenji@example.com', name: 'Kenji' }, { email: 'ada@example.com' }],
      ...extra,
    })

  test('a REQUEST names us as organizer and asks each attendee for an answer', () => {
    const db = (current = fresh())
    const event = planning(db)
    const { mail, event: sent } = eventInvites(db, event.id, 'request', FROM)
    expect(sent.organizer).toEqual({ email: ME, name: 'Mara Lin' })
    expect(mail.mail).toMatchObject({ to: ['kenji@example.com', 'ada@example.com'], subject: 'Invitation: Planning, Q3; budget' })
    expect(mail.mail.body).toContain('Where: Room 4')
    expect(mail.calendar).toMatchObject({ method: 'REQUEST', attach: true })
    const parsed = parseIcs(mail.calendar.ics)
    expect(parsed.method).toBe('REQUEST')
    expect(parsed.events[0]).toMatchObject({
      uid: event.uid,
      sequence: 0,
      summary: 'Planning, Q3; budget',
      start: Date.UTC(2026, 2, 12, 10),
      end: Date.UTC(2026, 2, 12, 11),
      organizer: { email: ME, name: 'Mara Lin' },
      attendees: [
        { email: 'kenji@example.com', name: 'Kenji', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true },
        { email: 'ada@example.com', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true },
      ],
    })
    // A one-off event goes out in UTC.
    expect(mail.calendar.ics).toContain('DTSTART:20260312T100000Z')
    expect(mail.calendar.ics).not.toContain('VTIMEZONE')
  })

  test('a change of time raises SEQUENCE; a CANCEL raises it again and marks the event cancelled', () => {
    const db = (current = fresh())
    const event = planning(db)
    eventInvites(db, event.id, 'request', FROM)
    saveEvent(db, { id: event.id, title: event.title, startAt: event.startAt + HOUR, endAt: event.endAt + HOUR })
    const update = eventInvites(db, event.id, 'request', FROM)
    expect(update.mail.mail.subject).toBe('Updated invitation: Planning, Q3; budget')
    expect(parseIcs(update.mail.calendar.ics).events[0]!.sequence).toBe(1)

    const cancel = eventInvites(db, event.id, 'cancel', FROM)
    expect(cancel.event).toMatchObject({ status: 'cancelled', sequence: 2 })
    expect(cancel.mail.mail.subject).toBe('Cancelled: Planning, Q3; budget')
    const parsed = parseIcs(cancel.mail.calendar.ics)
    expect([parsed.method, parsed.events[0]!.sequence, parsed.events[0]!.status]).toEqual(['CANCEL', 2, 'CANCELLED'])
  })

  test('a series goes out with its zone and its exceptions', () => {
    const db = (current = fresh())
    const series = planning(db, { recurrence: 'FREQ=WEEKLY;COUNT=3' })
    saveEvent(db, { id: series.id, title: 'Planning (moved)', startAt: series.startAt + DAY, endAt: series.endAt + DAY }, { scope: 'this', occurrenceStart: series.startAt + 7 * DAY })
    const { mail } = eventInvites(db, series.id, 'request', FROM)
    expect(mail.calendar.ics).toContain('DTSTART;TZID=Europe/Berlin:20260312T110000')
    expect(mail.calendar.ics).toContain('BEGIN:VTIMEZONE')
    const parsed = parseIcs(mail.calendar.ics)
    expect(parsed.events.map((e) => [e.summary, e.rrule ?? null, e.recurrenceId ?? null, e.start])).toEqual([
      ['Planning, Q3; budget', 'FREQ=WEEKLY;COUNT=3', null, Date.UTC(2026, 2, 12, 10)],
      ['Planning (moved)', null, Date.UTC(2026, 2, 19, 10), Date.UTC(2026, 2, 13, 10)],
    ])
    expect(parsed.events[0]!.exdates).toEqual([Date.UTC(2026, 2, 19, 10)])
  })

  test('a meeting link goes out in the body, as URL, and as the place when there is none', () => {
    const db = (current = fresh())
    const zoom = 'https://acme.zoom.us/j/123456'
    const { mail } = eventInvites(db, planning(db, { location: null, url: zoom }).id, 'request', FROM)
    expect(mail.mail.body).toContain(`Join Zoom: ${zoom}`)
    expect(parseIcs(mail.calendar.ics).events[0]).toMatchObject({ location: zoom, url: zoom })
    // A place of its own stays the place.
    const inRoom = eventInvites(db, planning(db, { url: zoom }).id, 'request', FROM)
    expect(parseIcs(inRoom.mail.calendar.ics).events[0]).toMatchObject({ location: 'Room 4', url: zoom })
  })

  test('an event without attendees, or someone else’s, has nothing to send', () => {
    const db = (current = fresh())
    const alone = saveEvent(db, { accountId: ACCOUNT, title: 'Focus', startAt: 0, endAt: HOUR })
    expect(() => eventInvites(db, alone.id, 'request', FROM)).toThrow('no one to invite')
    const theirs = planning(db, { organizer: { email: 'boss@org.example' } })
    expect(() => eventInvites(db, theirs.id, 'request', FROM)).toThrow('Only the organizer')
  })
})

describe('pending invites', () => {
  const NOW = Date.UTC(2026, 2, 5, 12)
  const titles = (db: MailDatabase, now = NOW) => pendingInvites(db, now).map((i) => i.title)

  test('unanswered, upcoming and not cancelled, soonest first, with where to open them', () => {
    const db = (current = fresh())
    const later = request(db, { uid: 'later@x', summary: 'Later', start: '20260320T150000Z', end: '20260320T160000Z' })
    const laterThread = `t${n}`
    request(db, { uid: 'soon@x', summary: 'Soon', start: '20260306T090000Z', end: '20260306T100000Z' })
    request(db, { uid: 'past@x', summary: 'Past', start: '20260301T090000Z', end: '20260301T100000Z' })
    const answered = request(db, { uid: 'answered@x', summary: 'Answered' })
    request(db, { uid: 'gone@x', summary: 'Gone' })
    applyNewInvites(db, ACCOUNT)
    request(db, { method: 'CANCEL', uid: 'gone@x', seq: 1 })
    applyNewInvites(db, ACCOUNT)
    respondToInvite(db, ACCOUNT, answered, 'accepted', FROM)
    // Our own event with a needs-action line of ours isn't an invitation: it came from no message.
    saveEvent(db, { title: 'Mine', startAt: NOW + DAY, endAt: NOW + DAY + HOUR, attendees: [{ email: ME, partstat: 'needs-action', self: true }] })

    expect(titles(db)).toEqual(['Soon', 'Later'])
    const [, summary] = pendingInvites(db, NOW)
    const row = Number(later.match(/-(\d+)$/)![1])
    expect(summary).toEqual({
      eventId: eventByUid(db, 'later@x')!.id,
      title: 'Later',
      startAt: Date.UTC(2026, 2, 20, 15),
      endAt: Date.UTC(2026, 2, 20, 16),
      allDay: false,
      timeZone: 'UTC',
      location: null,
      organizer: { email: 'boss@org.example', name: 'Boss' },
      accountId: ACCOUNT,
      threadId: uiThreadId(ACCOUNT, laterThread, row),
      messageId: later,
      recurring: false,
    })
    // Still going counts; over doesn't.
    expect(titles(db, Date.UTC(2026, 2, 6, 9, 30))).toEqual(['Soon', 'Later'])
    expect(titles(db, Date.UTC(2026, 2, 6, 10))).toEqual(['Later'])
  })

  test('a series shows its next occurrence; its own exception is not listed twice', () => {
    const db = (current = fresh())
    request(db, { uid: 'weekly@x', summary: 'Weekly', start: '20260302T090000Z', end: '20260302T093000Z', rrule: 'FREQ=WEEKLY;COUNT=4' })
    request(db, { uid: 'weekly@x', summary: 'Weekly (moved)', rid: '20260316T090000Z', start: '20260316T110000Z', end: '20260316T113000Z' })
    applyNewInvites(db, ACCOUNT)
    expect(pendingInvites(db, NOW).map((i) => [i.title, i.startAt, i.recurring])).toEqual([['Weekly', Date.UTC(2026, 2, 9, 9), true]])
    // After the last occurrence the series is over.
    expect(titles(db, Date.UTC(2026, 2, 24))).toEqual([])
  })

  test('invites held back for the Screener or Junk are not listed until answered', () => {
    const db = (current = fresh())
    const junk = request(db, { uid: 'junk@x', summary: 'From junk' }, { junk: true })
    applyNewInvites(db, ACCOUNT)
    expect(titles(db)).toEqual([])
    respondToInvite(db, ACCOUNT, junk, 'tentative', FROM)
    expect(titles(db)).toEqual([])
  })
})
