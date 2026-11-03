import { expect, test } from 'bun:test'
import type { EventOccurrence } from '../engine'
import { DAY, HOUR, addDays } from './dates'
import { addGuests, describeRule, draftFromEvent, draftFromPrefill, draftToInput, hasErrors, moveStart, parseTimeInput, repeatOptions, ruleForDay, sendsInvites, validateDraft } from './draft'
import { calendarState, closeEventEditor, editOccurrence, openEventEditor, setCalendarState, stepCursor } from './state'

const defaults = { calendarId: 'local', now: new Date(2026, 8, 26, 10, 12).getTime() }

test('a new event starts at the next half hour and lasts an hour', () => {
  const d = draftFromPrefill({}, defaults)
  expect([d.startDay, d.startMinutes, d.endMinutes, d.calendarId]).toEqual([new Date(2026, 8, 26).getTime(), 10 * 60 + 30, 11 * 60 + 30, 'local'])
  expect(hasErrors(validateDraft(d))).toBe(false)
})

test('a prefill from mail keeps its link; all-day prefills take an exclusive end', () => {
  const link = { kind: 'thread' as const, accountId: 'a', threadId: 'a:t1' }
  const start = new Date(2026, 9, 3).getTime()
  const d = draftFromPrefill({ title: 'Offsite', start, end: addDays(start, 2), allDay: true, link, attendees: ['kenji@northlight.co'] }, defaults)
  expect([d.startDay, d.endDay]).toEqual([start, addDays(start, 1)])
  const input = draftToInput(d)
  expect(input).toMatchObject({ title: 'Offsite', allDay: true, startAt: Date.UTC(2026, 9, 3), endAt: Date.UTC(2026, 9, 5), links: [link], calendarId: 'local' })
  expect(input.attendees).toEqual([{ email: 'kenji@northlight.co', role: 'required', partstat: 'needs-action', rsvp: true }])
  // Updates never re-link.
  expect(draftToInput(d, 'evt-1')).not.toHaveProperty('links')
})

test('validation: the end after the start, real addresses', () => {
  const d = draftFromPrefill({ start: new Date(2026, 8, 26, 14).getTime() }, defaults)
  expect(validateDraft({ ...d, endMinutes: 13 * 60 })).toEqual({ end: 'The event has to end after it starts' })
  expect(validateDraft({ ...d, endMinutes: 14 * 60 }).end).toBeDefined()
  // Ending the next morning is fine.
  expect(validateDraft({ ...d, endDay: addDays(d.startDay, 1), endMinutes: 60 })).toEqual({})
  expect(validateDraft({ ...d, allDay: true, endDay: addDays(d.startDay, -1) }).end).toBeDefined()
  expect(validateDraft({ ...d, attendees: ['ok@example.com', 'nope'] })).toEqual({ attendees: 'nope isn’t an email address' })
  expect(validateDraft({ ...d, endDay: addDays(d.startDay, 400) }).end).toBe('An event can last a year at most')
  expect(draftToInput({ ...d, title: '   ' }).title).toBe('New event')
})

test('a meeting link: typed without https, checked, stored as the event URL', () => {
  const d = draftFromPrefill({}, defaults)
  expect(draftToInput(d).url).toBeNull()
  expect(draftToInput({ ...d, url: ' zoom.us/j/123 ' }).url).toBe('https://zoom.us/j/123')
  expect(validateDraft({ ...d, url: 'call me maybe' })).toEqual({ url: 'That isn’t a link' })
  expect(draftFromEvent(occurrence({ url: 'https://meet.google.com/abc-defg-hij' })).url).toBe('https://meet.google.com/abc-defg-hij')
})

test('moving the start keeps the length', () => {
  const d = draftFromPrefill({ start: new Date(2026, 8, 26, 14).getTime(), end: new Date(2026, 8, 26, 15, 30).getTime() }, defaults)
  const later = moveStart(d, { startMinutes: 23 * 60 })
  expect([later.endDay, later.endMinutes]).toEqual([addDays(d.startDay, 1), 30])
  const allDay = { ...d, allDay: true, endDay: addDays(d.startDay, 2) }
  expect(moveStart(allDay, { startDay: addDays(d.startDay, 5) }).endDay).toBe(addDays(d.startDay, 7))
})

const occurrence = (patch: Partial<EventOccurrence> = {}): EventOccurrence => ({
  id: 'evt-1',
  key: 'evt-1',
  calendarId: 'local',
  uid: 'u@jefi',
  sequence: 0,
  accountId: null,
  title: 'Design review',
  startAt: new Date(2026, 8, 28, 15).getTime(),
  endAt: new Date(2026, 8, 28, 16).getTime(),
  allDay: false,
  timeZone: null,
  location: 'Room 4',
  description: null,
  url: null,
  status: 'confirmed',
  organizer: null,
  attendees: [{ email: 'lea@atlas.dev', name: 'Lea', partstat: 'accepted' }],
  recurrence: null,
  exdates: [],
  recurringMasterId: null,
  recurrenceId: null,
  alarms: null,
  invite: null,
  createdAt: 0,
  updatedAt: 0,
  recurring: false,
  occurrenceStart: new Date(2026, 8, 28, 15).getTime(),
  ...patch,
})

test('editing an event round-trips it, keeping what attendees answered', () => {
  const d = draftFromEvent(occurrence())
  expect([d.startMinutes, d.endMinutes, d.location, d.attendees]).toEqual([15 * 60, 16 * 60, 'Room 4', ['lea@atlas.dev']])
  const input = draftToInput({ ...d, attendees: [...d.attendees, 'nora@harbor.io'] }, 'evt-1')
  expect(input).toMatchObject({ id: 'evt-1', startAt: occurrence().startAt, endAt: occurrence().endAt, location: 'Room 4', description: null, recurrence: null })
  expect(input.attendees!.map((a) => [a.email, a.partstat])).toEqual([['lea@atlas.dev', 'accepted'], ['nora@harbor.io', 'needs-action']])

  const allDay = draftFromEvent(occurrence({ allDay: true, startAt: Date.UTC(2026, 8, 28), endAt: Date.UTC(2026, 8, 30) }))
  expect([allDay.startDay, allDay.endDay]).toEqual([new Date(2026, 8, 28).getTime(), new Date(2026, 8, 29).getTime()])
  expect(draftToInput(allDay)).toMatchObject({ startAt: Date.UTC(2026, 8, 28), endAt: Date.UTC(2026, 8, 30) })
})

test('times as people type them', () => {
  const cases: Array<[string, number | null]> = [
    ['9', 540], ['9:30', 570], ['930', 570], ['09:05', 545], ['9pm', 1260], ['9:30 p.m.', 1290], ['12am', 0], ['12 pm', 720],
    ['21:15', 1275], ['noon', 720], ['midnight', 0], ['14h30', 870], ['24:00', null], ['13pm', null], ['9:75', null], ['soon', null], ['', null],
  ]
  for (const [text, minutes] of cases) expect([text, parseTimeInput(text)]).toEqual([text, minutes])
})

test('repeat choices and rules in words', () => {
  const monday = new Date(2026, 8, 28).getTime()
  expect(repeatOptions(monday, 'en-US').map((o) => o.rule)).toEqual(['', 'FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', 'FREQ=MONTHLY', 'FREQ=YEARLY'])
  expect(describeRule('FREQ=WEEKLY;BYDAY=MO', monday, 'en-US')).toBe('Every week on Monday')
  expect(describeRule('FREQ=MONTHLY', monday, 'en-US')).toBe('Every month on the 28th')
  expect(describeRule('FREQ=DAILY;INTERVAL=3;COUNT=5', monday, 'en-US')).toBe('Every 3 days, 5 times')
  expect(describeRule('FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231', monday, 'en-US')).toBe('Every week on Tue, Thu, until Dec 31, 2026')
  expect(describeRule(null, monday)).toBe('Does not repeat')
})

test('the editor opens from anywhere through the calendar state', () => {
  const link = { kind: 'message' as const, accountId: 'a', messageId: 'a:t1-4' }
  setCalendarState({ selected: 'x' })
  openEventEditor({ title: 'Lunch', link })
  const first = calendarState().editor!
  expect([first.prefill, calendarState().selected]).toEqual([{ title: 'Lunch', link }, null])
  editOccurrence(occurrence())
  expect(calendarState().editor!.occurrence!.id).toBe('evt-1')
  expect(calendarState().editor!.key).toBeGreaterThan(first.key)
  closeEventEditor()
  expect(calendarState().editor).toBeNull()
})

test('prev and next step by the view’s period', () => {
  const t = new Date(2026, 0, 31, 10).getTime()
  expect(new Date(stepCursor('month', t, 1)).getDate()).toBe(28)
  expect(stepCursor('week', t, -1)).toBe(addDays(t, -7))
  expect(stepCursor('day', t, 1)).toBe(new Date(2026, 1, 1).getTime())
  expect(stepCursor('agenda', t, 1) - t).toBeGreaterThanOrEqual(14 * DAY - HOUR)
})

test('typed guests become addresses once each, through the contacts', () => {
  const contacts: Record<string, string> = { kenji: 'kenji@northlight.co' }
  expect(addGuests([], 'lea@atlas.dev')).toEqual(['lea@atlas.dev'])
  expect(addGuests(['Lea@Atlas.dev'], ' lea@atlas.dev, kenji;nora@harbor.io ', (p) => contacts[p])).toEqual(['Lea@Atlas.dev', 'kenji@northlight.co', 'nora@harbor.io'])
  expect(addGuests(['a@b.co'], '  ')).toEqual(['a@b.co'])
})

test('a weekly rule on the start weekday follows the event to another day', () => {
  const tuesday = new Date(2026, 8, 22).getTime()
  const wednesday = new Date(2026, 8, 23).getTime()
  expect(ruleForDay('FREQ=WEEKLY;BYDAY=TU', tuesday, wednesday)).toBe('FREQ=WEEKLY;BYDAY=WE')
  expect(ruleForDay('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=5', tuesday, wednesday)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=5')
  // Several days, another day, other frequencies and no rule are left alone.
  expect(ruleForDay('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', tuesday, wednesday)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
  expect(ruleForDay('FREQ=WEEKLY;BYDAY=FR', tuesday, wednesday)).toBe('FREQ=WEEKLY;BYDAY=FR')
  expect(ruleForDay('FREQ=MONTHLY', tuesday, wednesday)).toBe('FREQ=MONTHLY')
  expect(ruleForDay(null, tuesday, wednesday)).toBeNull()
  expect(ruleForDay('FREQ=WEEKLY;BYDAY=TU', tuesday, addDays(tuesday, 7))).toBe('FREQ=WEEKLY;BYDAY=TU')

  // In the editor: "Every week on Tuesday", then the date moves to Wednesday.
  const d = draftFromPrefill({ start: new Date(2026, 8, 22, 9).getTime() }, defaults)
  const weekly = repeatOptions(d.startDay).find((o) => o.label === 'Every week on Tuesday')!.rule
  const moved = moveStart({ ...d, recurrence: weekly }, { startDay: wednesday })
  expect(moved.recurrence).toBe(repeatOptions(wednesday).find((o) => o.label === 'Every week on Wednesday')!.rule)
  expect(moveStart({ ...d, recurrence: weekly }, { startMinutes: 11 * 60 }).recurrence).toBe(weekly)
})

test('a rule’s end date reads the same in every zone', () => {
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Auckland', 'Pacific/Pago_Pago', 'UTC']) {
    const before = process.env.TZ
    process.env.TZ = zone
    try {
      const day = new Date(2026, 8, 28).getTime()
      expect(describeRule('FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231', day, 'en-US')).toBe('Every week on Tue, Thu, until Dec 31, 2026')
    } finally {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  }
})

test('saving sends invitations only for the person’s own event with guests', () => {
  const d = draftFromPrefill({ attendees: ['lea@atlas.dev'] }, defaults)
  expect(sendsInvites(d)).toBe(true)
  expect(sendsInvites({ ...d, attendees: [] })).toBe(false)
  // An invitation received: the person is among its attendees, and Lea organizes it.
  const received = draftFromEvent({
    ...({} as EventOccurrence),
    title: 'Team sync',
    allDay: false,
    startAt: new Date(2026, 8, 27, 14).getTime(),
    endAt: new Date(2026, 8, 27, 15).getTime(),
    calendarId: 'local',
    location: null,
    description: null,
    recurrence: null,
    alarms: null,
    organizer: { email: 'lea@atlas.dev' },
    attendees: [{ email: 'lea@atlas.dev', partstat: 'accepted' }, { email: 'me@example.com', partstat: 'accepted', self: true }],
  })
  expect(sendsInvites(received)).toBe(false)
})
