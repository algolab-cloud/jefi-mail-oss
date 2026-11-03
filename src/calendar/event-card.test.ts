import { expect, test } from 'bun:test'
import type { EventOccurrence } from '../engine'
import { cancelsForGuests } from './event-card'

const now = new Date(2026, 8, 26, 12).getTime()
const event = (patch: Partial<EventOccurrence> = {}): EventOccurrence =>
  ({
    id: 'evt-1',
    key: 'evt-1',
    title: 'Planning',
    startAt: now + 3_600_000,
    endAt: now + 7_200_000,
    allDay: false,
    status: 'confirmed',
    recurring: false,
    recurringMasterId: null,
    accountId: 'acct-1',
    attendees: [{ email: 'lea@atlas.dev', partstat: 'needs-action' }],
    ...patch,
  }) as EventOccurrence

test('deleting the person’s own upcoming event with guests cancels it for them', () => {
  expect(cancelsForGuests(event(), 'all', now)).toBe(true)
  // No guests, never invited from an account, already over, already cancelled: nothing to send.
  expect(cancelsForGuests(event({ accountId: null }), 'all', now)).toBe(false)
  expect(cancelsForGuests(event({ attendees: [] }), 'all', now)).toBe(false)
  expect(cancelsForGuests(event({ startAt: now - 7_200_000, endAt: now - 3_600_000 }), 'all', now)).toBe(false)
  expect(cancelsForGuests(event({ status: 'cancelled' }), 'all', now)).toBe(false)
  // An invitation someone else sent: deleting it is the person's own business.
  expect(cancelsForGuests(event({ attendees: [{ email: 'lea@atlas.dev' }, { email: 'me@example.com', self: true }] }), 'all', now)).toBe(false)
  // A series: only when the whole of it goes.
  expect(cancelsForGuests(event({ recurring: true }), 'all', now)).toBe(true)
  expect(cancelsForGuests(event({ recurring: true }), 'this', now)).toBe(false)
  expect(cancelsForGuests(event({ recurring: true }), 'following', now)).toBe(false)
})
