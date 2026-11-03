import { afterEach, expect, test } from 'bun:test'
import type { NotificationPermission } from './native/notify'
import { cachedNotificationPermission, readNotificationPermission, rememberNotificationPermission } from './notification-permission'

afterEach(() => rememberNotificationPermission(null))

test('the last answer from macOS is kept, so a row mounting again starts from it', async () => {
  expect(cachedNotificationPermission()).toBeNull()
  expect(await readNotificationPermission(async () => 'denied')).toBe('denied')
  expect(cachedNotificationPermission()).toBe('denied')
  // A later read replaces it.
  await readNotificationPermission(async () => 'granted')
  expect(cachedNotificationPermission()).toBe('granted')
})

test('reads under way are shared, so slow ones never stack up', async () => {
  let calls = 0
  let answer!: (value: NotificationPermission) => void
  const slow = () => (calls++, new Promise<NotificationPermission>((done) => (answer = done)))
  const first = readNotificationPermission(slow)
  const second = readNotificationPermission(slow)
  expect(calls).toBe(1)
  answer('undetermined')
  expect(await first).toBe('undetermined')
  expect(await second).toBe('undetermined')
  // Once answered, the next read asks again.
  await readNotificationPermission(async () => (calls++, 'granted'))
  expect(calls).toBe(2)
})

test('a failed read keeps the last answer and lets the next one through', async () => {
  rememberNotificationPermission('granted')
  await expect(readNotificationPermission(() => Promise.reject(new Error('no')))).rejects.toThrow('no')
  expect(cachedNotificationPermission()).toBe('granted')
  expect(await readNotificationPermission(async () => 'denied')).toBe('denied')
})
