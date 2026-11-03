import { expect, test } from 'bun:test'
import { appBundleId, createPermissionBridge, EVENT_IMAGE, notificationImageSpec, senderColor, senderImage, TASK_IMAGE, notificationSettingsUrl, permissionFromStatus, appleScriptString, dispatchEventOpen, dispatchNotificationOpen, eventNotificationIdentifier, subscribeEventOpens, notificationHelperPath, notificationIdentifier, notificationScript, subscribeNotificationOpens } from './notify'

test('quotes and backslashes in a subject can not break out of the script', () => {
  expect(appleScriptString('Q3 "review"')).toBe('"Q3 \\"review\\""')
  expect(appleScriptString('C:\\path')).toBe('"C:\\\\path"')
  // A subject ending a statement and starting another must stay one string.
  const script = notificationScript({ title: 'Ada', body: '" & (do shell script "id") & "' })
  expect(script.match(/"/g)!.length % 2).toBe(0)
  expect(script).not.toContain('& (do shell script "id") &"')
})

test('newlines are flattened: display notification takes one line', () => {
  expect(appleScriptString('first\nsecond\r\nthird')).toBe('"first second third"')
})

test('the script carries sender, account and subject', () => {
  expect(notificationScript({ title: 'Ada Lovelace', subtitle: 'me@example.com', body: 'Invoice for March' })).toBe(
    'display notification "Invoice for March" with title "Ada Lovelace" subtitle "me@example.com"',
  )
  // No account given (a single mailbox): no empty subtitle line.
  expect(notificationScript({ title: 'Ada', body: 'Hi' })).toBe('display notification "Hi" with title "Ada"')
})

test('notification routes preserve the exact account and conversation identifiers', async () => {
  const route = { accountId: 'work@example.com', threadId: 'work@example.com:thread/A' }
  expect(notificationIdentifier(route)).toBe('jefi-mail:work@example.com:work@example.com:thread/A')
  expect(dispatchNotificationOpen(route)).toBe(true)
  const opened: typeof route[] = []
  const unsubscribe = subscribeNotificationOpens((value) => opened.push(value))
  await Promise.resolve()
  expect(opened).toEqual([route])
  expect(dispatchNotificationOpen({ accountId: '', threadId: route.threadId })).toBe(false)
  unsubscribe()
})

test('the signed bundle resolves its app-owned native helper', () => {
  expect(notificationHelperPath('/Applications/Jefi.app/Contents/MacOS/Jefi')).toBe(
    '/Applications/Jefi.app/Contents/Frameworks/libJefiNotifications.dylib',
  )
})

test('event routes carry the event and its occurrence, and wait for a listener', async () => {
  const route = { eventId: 'evt-1', occurrenceStart: 1_773_130_800_000 }
  expect(eventNotificationIdentifier(route)).toBe('jefi-event:evt-1@1773130800000')
  expect(dispatchEventOpen(route)).toBe(true)
  const opened: typeof route[] = []
  const unsubscribe = subscribeEventOpens((value) => opened.push(value))
  await Promise.resolve()
  expect(opened).toEqual([route])
  expect(dispatchEventOpen({ eventId: '', occurrenceStart: 1 })).toBe(false)
  expect(dispatchEventOpen({ eventId: 'evt-1', occurrenceStart: Number.NaN })).toBe(false)
  unsubscribe()
})

test('helper status codes map to the four permission states', () => {
  expect([0, 1, 2, 3, 4, -1, 9].map(permissionFromStatus)).toEqual(['undetermined', 'denied', 'granted', 'granted', 'granted', 'unavailable', 'unavailable'])
})

test('permission answers find their own promise by token', async () => {
  const asked: Array<[string, number]> = []
  const bridge = createPermissionBridge(() => ({
    status: (token) => (asked.push(['status', token]), true),
    request: (token) => (asked.push(['request', token]), true),
  }))
  const first = bridge.status()
  const second = bridge.request()
  // Out of order: the request is answered before the status.
  bridge.deliver(asked[1]![1], 2)
  bridge.deliver(asked[0]![1], 1)
  expect(await first).toBe('denied')
  expect(await second).toBe('granted')
})

test('no helper, a refused call or a silent helper settle as unavailable', async () => {
  expect(await createPermissionBridge(() => null).status()).toBe('unavailable')
  expect(await createPermissionBridge(() => ({ status: () => false, request: () => false })).request()).toBe('unavailable')
  expect(await createPermissionBridge(() => ({ status: () => true, request: () => true }), 10).status()).toBe('unavailable')
})

test('a failed prompt reads the standing setting back', async () => {
  const tokens: number[] = []
  const bridge = createPermissionBridge(() => ({ status: (t) => (tokens.push(t), true), request: (t) => (tokens.push(t), true) }))
  const answer = bridge.request()
  bridge.deliver(tokens[0]!, -1)
  for (let i = 0; i < 5 && tokens.length < 2; i++) await Promise.resolve()
  bridge.deliver(tokens[1]!, 1)
  expect(await answer).toBe('denied')
})

test('System Settings opens on Jefi’s own notification page', () => {
  expect(notificationSettingsUrl('app.jefi.mail')).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.jefi.mail')
  // No Info.plist beside an unbundled binary: the release id.
  expect(appBundleId('/nowhere/Jefi.app/Contents/MacOS/Jefi')).toBe('app.jefi.mail')
})

test('a banner picture reaches the helper as one tab-separated line, with nothing that could split it', () => {
  expect(notificationImageSpec(undefined)).toBe('')
  expect(notificationImageSpec({ kind: 'initials', text: 'NH', color: '#3E63DD' })).toBe('initials\tNH\t#3E63DD')
  expect(notificationImageSpec({ kind: 'photo', path: '/tmp/a\tb\nc.jpg' })).toBe('photo\t/tmp/a b c.jpg')
  expect(notificationImageSpec(TASK_IMAGE)).toBe('symbol\tchecklist\t#8B5CF6')
  expect(notificationImageSpec(EVENT_IMAGE)).toBe('symbol\tcalendar\t#E5484D')
})

test('a sender keeps one colour whatever the case of their address', () => {
  expect(senderColor('Nora@Harbor.io')).toBe(senderColor('nora@harbor.io '))
  expect(senderColor('nora@harbor.io')).toMatch(/^#[0-9A-F]{6}$/)
})

test('the sender shows as initials, or nothing when there are none', () => {
  expect(senderImage({ letter: 'NH' }, 'nora@harbor.io')).toEqual({ kind: 'initials', text: 'NH', color: senderColor('nora@harbor.io') })
  expect(senderImage({ letter: ' ' }, 'nora@harbor.io')).toBeUndefined()
  // Only a data-URL photo is written out for the helper; anything else falls back to the initials.
  expect(senderImage({ src: 'https://example.com/a.png', letter: 'A' }, 'a@example.com')?.kind).toBe('initials')
})

test('a data-URL photo is written once, as a file the helper can open', () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const first = senderImage({ src: `data:image/png;base64,${pixel}` }, 'a@example.com')
  expect(first?.kind).toBe('photo')
  const path = first?.kind === 'photo' ? first.path : ''
  expect(require('node:fs').existsSync(path)).toBe(true)
  expect(senderImage({ src: `data:image/png;base64,${pixel}` }, 'b@example.com')).toEqual(first)
})
