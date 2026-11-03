import { expect, test } from 'bun:test'
import { parseIcs } from '../../detect/ics'
import { escapeText, foldLine, PRODID, vtimezone, writeCalendar, type VEventOut } from './ics-write'

const base: VEventOut = {
  uid: 'abc@jefi',
  sequence: 3,
  dtstamp: Date.UTC(2026, 2, 1, 9),
  title: 'Review',
  startAt: Date.UTC(2026, 2, 12, 10),
  endAt: Date.UTC(2026, 2, 12, 11),
  allDay: false,
  timeZone: 'UTC',
}

const octets = (s: string) => new TextEncoder().encode(s).length

test('lines end in CRLF, fold at 75 octets without splitting a character, and unfold back', () => {
  const description = `Agenda: ${'café ☕ 日本語 '.repeat(20)}\nLine two; with, punctuation\\done`
  const text = writeCalendar('REQUEST', [{ ...base, description }])
  expect(text.endsWith('\r\n')).toBe(true)
  expect(text.replace(/\r\n/g, '')).not.toContain('\n')
  for (const line of text.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75)
  expect(text).toContain('\r\n ')
  expect(parseIcs(text).events[0]!.description).toBe(description.trim())
  // A fold never lands inside a multibyte character.
  expect(text).not.toContain('�')
  expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75))
  expect(foldLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`)
})

test('text is escaped and parameters are quoted', () => {
  expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne')
  const text = writeCalendar('REQUEST', [
    { ...base, title: 'Q3; budget, plan', location: 'Room 4, B', organizer: { email: 'me@example.com', name: 'Lin, Mara' }, attendees: [{ email: 'k@example.com', name: 'Kenji "K" Sato' }] },
  ])
  expect(text).toContain('SUMMARY:Q3\\; budget\\, plan')
  expect(text).toContain('ORGANIZER;CN="Lin, Mara":mailto:me@example.com')
  expect(text.replace(/\r\n /g, '')).toContain("CN=Kenji 'K' Sato:mailto:k@example.com")
  const [ev] = parseIcs(text).events
  expect([ev!.summary, ev!.location, ev!.organizer, ev!.attendees[0]!.name]).toEqual(['Q3; budget, plan', 'Room 4, B', { email: 'me@example.com', name: 'Lin, Mara' }, "Kenji 'K' Sato"])
})

test('header, UTC DTSTAMP, all-day dates', () => {
  const text = writeCalendar('CANCEL', [{ ...base, allDay: true, timeZone: null, startAt: Date.UTC(2026, 2, 3), endAt: Date.UTC(2026, 2, 5), status: 'CANCELLED' }])
  expect(text.split('\r\n').slice(0, 5)).toEqual(['BEGIN:VCALENDAR', `PRODID:${PRODID}`, 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:CANCEL'])
  expect(text).toContain('DTSTAMP:20260301T090000Z')
  expect(text).toContain('DTSTART;VALUE=DATE:20260303')
  expect(text).toContain('DTEND;VALUE=DATE:20260305')
  const parsed = parseIcs(text)
  expect([parsed.method, parsed.events[0]!.startDate, parsed.events[0]!.endDate, parsed.events[0]!.status]).toEqual(['CANCEL', '2026-03-03', '2026-03-05', 'CANCELLED'])
})

test('a series in a zone gets TZID, a VTIMEZONE that resolves on its own, and a UTC UNTIL', () => {
  const series: VEventOut = { ...base, timeZone: 'America/New_York', startAt: Date.UTC(2026, 2, 2, 14), endAt: Date.UTC(2026, 2, 2, 15), recurrence: 'FREQ=WEEKLY;UNTIL=20260406T090000', exdates: [Date.UTC(2026, 2, 16, 13)] }
  const text = writeCalendar('REQUEST', [series])
  expect(text).toContain('DTSTART;TZID=America/New_York:20260302T090000')
  expect(text).toContain('RRULE:FREQ=WEEKLY;UNTIL=20260406T130000Z')
  expect(text).toContain('EXDATE;TZID=America/New_York:20260316T090000')
  expect(vtimezone('America/New_York', 2026)).toEqual([
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'X-LIC-LOCATION:America/New_York',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ])
  // Under a name no zone database knows, the times come from the VTIMEZONE rules alone.
  const custom = parseIcs(text.replaceAll('America/New_York', 'Custom Eastern'), { timeZone: 'Asia/Tokyo' })
  expect(custom.events[0]!.start).toBe(Date.UTC(2026, 2, 2, 14))
  expect(custom.events[0]!.exdates).toEqual([Date.UTC(2026, 2, 16, 13)])
  // A zone without DST: one fixed offset.
  expect(vtimezone('Asia/Tokyo', 2026)).toContain('TZOFFSETTO:+0900')
})
