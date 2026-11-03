import { expect, test } from 'bun:test'
import type { Reminder } from '../engine'
import { clearRecent, recentNotifications } from '../menubar-data'
import { onReminderShown } from './reminder-banners'

const start = Date.UTC(2026, 8, 28, 14)
const reminder = (minutesBefore: number): Reminder => ({
  eventId: 'ev1', occurrenceStart: start, title: 'Board dry run', location: 'Boardroom', startAt: start, endAt: start + 3_600_000,
  allDay: false, recurring: false, minutesBefore, fireAt: start - minutesBefore * 60_000,
})

test('a shown reminder lands in the recent list, one entry per occurrence', () => {
  clearRecent()
  onReminderShown(reminder(10), start - 600_000)
  onReminderShown(reminder(5), start - 300_000)
  const { items } = recentNotifications()
  expect(items.length).toBe(1)
  expect(items[0]).toMatchObject({ id: `reminder:ev1@${start}`, kind: 'reminder', title: 'Board dry run', at: start - 300_000, route: { eventId: 'ev1', occurrenceStart: start } })
  clearRecent()
})
