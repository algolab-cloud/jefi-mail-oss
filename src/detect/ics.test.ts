import { describe, expect, test } from 'bun:test'
import { parseIcs } from './ics'
import { zonedToEpoch } from './tz'

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n'

const google = crlf([
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'X-LIC-LOCATION:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/New_York:20261005T140000',
  'DTEND;TZID=America/New_York:20261005T150000',
  'DTSTAMP:20260924T120000Z',
  'ORGANIZER;CN=Alice Smith:mailto:alice@example.com',
  'UID:abc123@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=',
  ' TRUE;CN="Bob, Jr.";X-NUM-GUESTS=0:mailto:bob@example.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=alice@e',
  ' xample.com;X-NUM-GUESTS=0:mailto:alice@example.com',
  'CREATED:20260924T115959Z',
  'DESCRIPTION:Agenda:\\n1. Roadmap\\n2. Budget\\, hiring\\; misc\\\\done\\n\\nJoin w',
  ' ith Google Meet: https://meet.google.com/abc-defg-hij',
  'LOCATION:Room 4\\, Building B',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Design review',
  'TRANSP:OPAQUE',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H10M0S',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
])

// Outlook with a Windows zone name and its VTIMEZONE block.
const outlook = crlf([
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Jan de Vries:mailto:jan@contoso.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Eric:mailto:eric@example.com',
  'DESCRIPTION;LANGUAGE=en-US:Quarterly planning\\n',
  'UID:040000008200E00074C5B7101A82E00800000000',
  'SUMMARY;LANGUAGE=en-US:Q4 planning',
  'DTSTART;TZID=W. Europe Standard Time:20261026T100000',
  'DTEND;TZID=W. Europe Standard Time:20261026T113000',
  'CLASS:PUBLIC',
  'PRIORITY:5',
  'DTSTAMP:20260924T090000Z',
  'TRANSP:OPAQUE',
  'STATUS:CONFIRMED',
  'SEQUENCE:2',
  'LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting',
  'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE',
  'END:VEVENT',
  'END:VCALENDAR',
])

describe('parseIcs', () => {
  test('Google Calendar invite', () => {
    const cal = parseIcs(google)
    expect(cal.method).toBe('REQUEST')
    expect(cal.events).toHaveLength(1)
    const e = cal.events[0]!
    expect(e.uid).toBe('abc123@google.com')
    expect(e.summary).toBe('Design review')
    expect(e.sequence).toBe(0)
    expect(e.status).toBe('CONFIRMED')
    expect(e.allDay).toBe(false)
    expect(e.timeZone).toBe('America/New_York')
    expect(iso(e.start)).toBe('2026-10-05T18:00:00.000Z')
    expect(iso(e.end)).toBe('2026-10-05T19:00:00.000Z')
    expect(e.location).toBe('Room 4, Building B')
    expect(e.description).toBe('Agenda:\n1. Roadmap\n2. Budget, hiring; misc\\done\n\nJoin with Google Meet: https://meet.google.com/abc-defg-hij')
    expect(e.organizer).toEqual({ name: 'Alice Smith', email: 'alice@example.com' })
    expect(e.attendees).toEqual([
      { name: 'Bob, Jr.', email: 'bob@example.com', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT', rsvp: true },
      { name: 'alice@example.com', email: 'alice@example.com', partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' },
    ])
  })

  test('Outlook invite with a Windows TZID, after the October DST change', () => {
    const e = parseIcs(outlook).events[0]!
    expect(e.timeZone).toBe('Europe/Berlin')
    expect(iso(e.start)).toBe('2026-10-26T09:00:00.000Z')
    expect(iso(e.end)).toBe('2026-10-26T10:30:00.000Z')
    expect(e.sequence).toBe(2)
    expect(e.description).toBe('Quarterly planning')
    expect(e.location).toBe('Microsoft Teams Meeting')
  })

  test('custom Exchange zone name falls back to the VTIMEZONE rules', () => {
    const custom = outlook.replaceAll('W. Europe Standard Time', 'Customized Time Zone')
    const e = parseIcs(custom).events[0]!
    expect(e.timeZone).toBeUndefined()
    expect(iso(e.start)).toBe('2026-10-26T09:00:00.000Z')
    // Before the change the same rules give UTC+2.
    const summer = parseIcs(custom.replace('20261026T100000', '20261023T100000')).events[0]!
    expect(iso(summer.start)).toBe('2026-10-23T08:00:00.000Z')
  })

  test('all-day invite, LF endings', () => {
    const cal = parseIcs([
      'BEGIN:VCALENDAR',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:allday-1',
      'SUMMARY:Company offsite',
      'DTSTART;VALUE=DATE:20261012',
      'DTEND;VALUE=DATE:20261015',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n'), { timeZone: 'Europe/Berlin' })
    const e = cal.events[0]!
    expect(cal.method).toBe('PUBLISH')
    expect(e.allDay).toBe(true)
    expect(e.startDate).toBe('2026-10-12')
    expect(e.endDate).toBe('2026-10-15')
    expect(iso(e.start)).toBe('2026-10-11T22:00:00.000Z')
    expect(iso(e.end)).toBe('2026-10-14T22:00:00.000Z')
    expect(e.timeZone).toBeUndefined()
  })

  test('CANCEL', () => {
    const cal = parseIcs(crlf([
      'BEGIN:VCALENDAR',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      'UID:abc123@google.com',
      'SEQUENCE:1',
      'STATUS:CANCELLED',
      'SUMMARY:Canceled: Design review',
      'DTSTART:20261005T180000Z',
      'DTEND:20261005T190000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ]))
    expect(cal.method).toBe('CANCEL')
    const e = cal.events[0]!
    expect(e.status).toBe('CANCELLED')
    expect(e.sequence).toBe(1)
    expect(e.timeZone).toBe('UTC')
    expect(iso(e.start)).toBe('2026-10-05T18:00:00.000Z')
  })

  test('recurring invite keeps RRULE as text and honours DURATION', () => {
    const e = parseIcs(crlf([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:weekly',
      'SUMMARY:Weekly sync',
      'DTSTART;TZID="America/New_York":20260309T093000',
      'DURATION:PT30M',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z',
      'URL:https://example.com/e/1',
      'END:VEVENT',
      'END:VCALENDAR',
    ])).events[0]!
    expect(e.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z')
    // March 9 is the day after the US spring change: EDT.
    expect(iso(e.start)).toBe('2026-03-09T13:30:00.000Z')
    expect(iso(e.end)).toBe('2026-03-09T14:00:00.000Z')
    expect(e.url).toBe('https://example.com/e/1')
  })

  test('floating times use the given zone', () => {
    const text = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:f\nSUMMARY:Float\nDTSTART:20261005T090000\nEND:VEVENT\nEND:VCALENDAR'
    expect(iso(parseIcs(text, { timeZone: 'Asia/Tokyo' }).events[0]!.start)).toBe('2026-10-05T00:00:00.000Z')
    expect(iso(parseIcs(text).events[0]!.start)).toBe('2026-10-05T09:00:00.000Z')
  })

  test('robust to junk', () => {
    expect(parseIcs('')).toEqual({ events: [] })
    expect(parseIcs('not a calendar\nat all')).toEqual({ events: [] })
    const cal = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:garbage\nEND:VEVENT\nBEGIN:VEVENT\nUID:y\nSUMMARY:ok\nDTSTART:20261005T090000Z\nEND:VCALENDAR')
    expect(cal.events.map((e) => e.uid)).toEqual(['y'])
  })
})

describe('zonedToEpoch DST edges', () => {
  const w = (s: string) => {
    const [d, t] = s.split('T')
    const [year, month, day] = d!.split('-').map(Number)
    const [hour, minute] = t!.split(':').map(Number)
    return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: 0 }
  }
  test('Europe/Berlin, last Sunday of October', () => {
    expect(iso(zonedToEpoch(w('2026-10-25T01:59'), 'Europe/Berlin'))).toBe('2026-10-24T23:59:00.000Z')
    expect(iso(zonedToEpoch(w('2026-10-25T02:30'), 'Europe/Berlin'))).toBe('2026-10-25T00:30:00.000Z')
    expect(iso(zonedToEpoch(w('2026-10-25T03:00'), 'Europe/Berlin'))).toBe('2026-10-25T02:00:00.000Z')
  })
  test('America/New_York, second Sunday of March', () => {
    expect(iso(zonedToEpoch(w('2026-03-08T01:59'), 'America/New_York'))).toBe('2026-03-08T06:59:00.000Z')
    expect(iso(zonedToEpoch(w('2026-03-08T02:30'), 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z')
    expect(iso(zonedToEpoch(w('2026-03-08T03:00'), 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z')
  })
})
