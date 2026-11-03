import { expect, test } from 'bun:test'
import { attendeeSummary, recurrenceSummary, whenLines } from './invite-card'

test('recurrence reads as a sentence', () => {
  expect(recurrenceSummary('FREQ=WEEKLY')).toBe('Every week')
  expect(recurrenceSummary('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6')).toBe('Every 2 weeks on Mon, Thu, 6 times')
  expect(recurrenceSummary('FREQ=DAILY;UNTIL=20260331T235959Z')).toMatch(/^Every day, until .*2026$/)
})

test('attendees read as names and a tally, leaving us out', () => {
  expect(attendeeSummary([{ email: 'me@example.com', self: true }])).toBe('')
  expect(attendeeSummary([{ email: 'kenji@example.com', name: 'Kenji', partstat: 'accepted' }, { email: 'ada@example.com' }])).toBe('Kenji and ada@example.com · 1 accepted')
  expect(
    attendeeSummary([
      { email: 'a@x.example', name: 'A', partstat: 'declined' },
      { email: 'b@x.example', name: 'B', partstat: 'tentative' },
      { email: 'c@x.example', name: 'C' },
      { email: 'd@x.example', name: 'D', partstat: 'accepted' },
      { email: 'me@example.com', self: true, partstat: 'accepted' },
    ]),
  ).toBe('A, B and 2 others · 1 accepted, 1 maybe, 1 declined')
})

test('the organizer line shows only for a real zone that reads differently from ours', () => {
  // Tue 6 Oct 2026, 14:00–15:00 UTC.
  const at = { startAt: Date.UTC(2026, 9, 6, 14), endAt: Date.UTC(2026, 9, 6, 15), allDay: false }
  // Written in UTC (DTSTART:…Z): says nothing about the organizer, so no "(UTC)" line, wherever we are.
  for (const zone of ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']) {
    expect(whenLines({ ...at, timeZone: zone }, 'Europe/Berlin')).toHaveLength(1)
    expect(whenLines({ ...at, timeZone: zone }, 'UTC')).toHaveLength(1)
  }
  // Our own zone, no zone, or one Intl doesn't know: one line.
  expect(whenLines({ ...at, timeZone: 'Europe/Berlin' }, 'Europe/Berlin')).toHaveLength(1)
  expect(whenLines({ ...at, timeZone: null }, 'Europe/Berlin')).toHaveLength(1)
  expect(whenLines({ ...at, timeZone: 'Not/AZone' }, 'Europe/Berlin')).toHaveLength(1)
  // Another zone on the same clock (Paris and Berlin): nothing new to say.
  expect(whenLines({ ...at, timeZone: 'Europe/Paris' }, 'Europe/Berlin')).toHaveLength(1)
  // A genuinely different organizer zone keeps its line, labelled.
  const ny = whenLines({ ...at, timeZone: 'America/New_York' }, 'Europe/Berlin')
  expect(ny).toHaveLength(2)
  expect(ny[1]).toEndWith('(America/New York)')
  // Even when we are on UTC ourselves.
  expect(whenLines({ ...at, timeZone: 'America/New_York' }, 'UTC')).toHaveLength(2)
})
