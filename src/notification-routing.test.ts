import { expect, test } from 'bun:test'
import { notificationRequestBelongsToAccount, resolveNotificationEvent, resolveNotificationThread } from './notification-routing'

test('notification routing uses an exact targeted load when a cold-start snapshot is not ready', async () => {
  const target = { id: 'acct-work:thread-42' }
  let loads = 0
  const resolved = await resolveNotificationThread(target.id, [], async (id) => {
    loads++
    return id === target.id ? target : null
  })
  expect(resolved).toBe(target)
  expect(loads).toBe(1)
})

test('notification routing avoids a load for a visible thread and resolves a missing target', async () => {
  const target = { id: 'acct-work:thread-42' }
  let loads = 0
  expect(await resolveNotificationThread(target.id, [target], async () => { loads++; return null })).toBe(target)
  expect(loads).toBe(0)
  expect(await resolveNotificationThread('acct-work:gone', [], async () => null)).toBeNull()
})

test('account removal invalidates only that account notification request', () => {
  expect(notificationRequestBelongsToAccount('acct-work:thread-42', 'acct-work')).toBe(true)
  expect(notificationRequestBelongsToAccount('acct-home:thread-42', 'acct-work')).toBe(false)
  expect(notificationRequestBelongsToAccount(null, 'acct-work')).toBe(false)
})

test('a reminder banner opens its occurrence: a series by occurrence key, a single event by id', async () => {
  const base = { id: 'evt-1', startAt: 1000, allDay: false, recurrence: null as string | null }
  const load = (event: typeof base | null) => async () => event as never
  expect(await resolveNotificationEvent({ eventId: 'evt-1', occurrenceStart: 1000 }, load(base))).toEqual({ ...base, key: 'evt-1' })
  const series = { ...base, recurrence: 'FREQ=DAILY' }
  expect(await resolveNotificationEvent({ eventId: 'evt-1', occurrenceStart: 5000 }, load(series))).toEqual({ ...series, startAt: 5000, key: 'evt-1@5000' })
  expect(await resolveNotificationEvent({ eventId: 'gone', occurrenceStart: 1 }, load(null))).toBeNull()
})
