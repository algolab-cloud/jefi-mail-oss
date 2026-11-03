import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { FaceSpec } from '../data'
import { CString, dlopen, FFIType, JSCallback, type Pointer } from 'bun:ffi'
import { cls, msg, msgInt } from './objc'

// ---------------------------------------------------------------------------
// New-mail banners and click routing through macOS UserNotifications.
//
// The bundled native helper owns every Apple callback. Apple's authorization and delegate queues
// are unspecified, so the helper retains the response data and returns to the main queue before it
// calls this module. No Objective-C object or completion block crosses into JavaScript.
// `osascript` remains a development fallback for an unbundled Bun process.
// ---------------------------------------------------------------------------

export type NotificationRoute = { accountId: string; threadId: string }
/** `copy`: a sign-in code the banner offers to copy with its "Copy code" button. */
export type MailNotification = NotificationRoute & { title: string; subtitle?: string; body: string; image?: NotificationImage; copy?: string }
type RouteListener = (route: NotificationRoute) => void
/** An event reminder's banner opens that occurrence in the calendar. */
export type EventRoute = { eventId: string; occurrenceStart: number }
export type EventNotification = EventRoute & { title: string; subtitle?: string; body: string; image?: NotificationImage }
type EventListener = (route: EventRoute) => void

export const notificationsAvailable = process.platform === 'darwin'

// ---------------------------------------------------------------------------
// The picture a banner shows beside its text: the sender's photo or initials for mail, a symbol for
// a task or event reminder. The helper draws it (jefiNotificationImageData in notifications.m). A
// release build with the Communication Notifications entitlement sends the banner as a message from
// a person with this picture, so it takes the app icon's place; other builds show the app icon
// alone.
// ---------------------------------------------------------------------------

export type NotificationImage =
  | { kind: 'photo'; path: string }
  | { kind: 'initials'; text: string; color: string }
  | { kind: 'symbol'; name: string; color: string }

/** A sender keeps one colour, picked from the address, so the same person looks the same each time. */
const SENDER_COLORS = ['#3E63DD', '#8E4EC6', '#D6409F', '#E5484D', '#F76B15', '#12A594', '#30A46C', '#0090FF', '#AB4ABA', '#E54666']
export function senderColor(email: string) {
  const key = email.trim().toLowerCase()
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return SENDER_COLORS[hash % SENDER_COLORS.length]!
}

/** SF Symbols in the colours the app uses for each. */
export const TASK_IMAGE: NotificationImage = { kind: 'symbol', name: 'checklist', color: '#8B5CF6' }
export const EVENT_IMAGE: NotificationImage = { kind: 'symbol', name: 'calendar', color: '#E5484D' }
/** A burst from several people has no one face: an envelope stands for all of them. */
export const MAIL_IMAGE: NotificationImage = { kind: 'symbol', name: 'envelope.fill', color: '#3E63DD' }

/** The text the helper reads: the kind and its fields, tab-separated (tabs and NULs never get in). */
export function notificationImageSpec(image: NotificationImage | undefined): string {
  if (!image) return ''
  const field = (value: string) => value.replace(/[\t\0\n]/g, ' ').trim()
  if (image.kind === 'photo') return `photo\t${field(image.path)}`
  if (image.kind === 'initials') return `initials\t${field(image.text)}\t${image.color}`
  return `symbol\t${field(image.name)}\t${image.color}`
}

/** The sender's face as a banner shows it: their photo when there is one, else their initials. */
export function senderImage(face: FaceSpec, email: string): NotificationImage | undefined {
  const photo = face.src ? photoFile(face.src) : null
  if (photo) return { kind: 'photo', path: photo }
  return face.letter?.trim() ? { kind: 'initials', text: face.letter.trim(), color: senderColor(email) } : undefined
}

/** A data-URL photo written once to a file the helper can open (named by its content). */
function photoFile(src: string): string | null {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(src)
  if (!match) return null
  try {
    const dir = resolve(tmpdir(), 'jefi-faces')
    const path = resolve(dir, `${createHash('sha256').update(match[2]!).digest('hex').slice(0, 24)}.${match[1]!.toLowerCase()}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Create-only ('wx'), private to this user: no gap between checking for the file and writing it.
    try {
      writeFileSync(path, Buffer.from(match[2]!, 'base64'), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return path
  } catch {
    return null
  }
}

let pendingOpen: NotificationRoute | null = null
const openListeners = new Set<RouteListener>()
let pendingEventOpen: EventRoute | null = null
const eventListeners = new Set<EventListener>()

/** True while Jefi is the app in front: its own toasts are enough then. */
export function appIsActive(): boolean {
  try {
    return notificationsAvailable && msgInt(msg(cls('NSApplication'), 'sharedApplication'), 'isActive') === 1
  } catch {
    return false
  }
}

/** A string as AppleScript source: quotes and backslashes escaped, newlines flattened. */
export function appleScriptString(value: string): string {
  const escaped = value.replace(/[\\"]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, ' ')
  return `"${escaped}"`
}

/** One line of AppleScript for the unbundled development fallback. */
export function notificationScript({ title, subtitle, body }: { title: string; subtitle?: string; body: string }): string {
  const parts = [`display notification ${appleScriptString(body)}`, `with title ${appleScriptString(title)}`]
  if (subtitle) parts.push(`subtitle ${appleScriptString(subtitle)}`)
  return parts.join(' ')
}

/** Stable request id: rescheduling the same conversation replaces its pending banner. */
export const notificationIdentifier = ({ accountId, threadId }: NotificationRoute) => `jefi-mail:${accountId}:${threadId}`

/** Shared by the native delegate and deterministic integration tests. */
export function dispatchNotificationOpen(route: NotificationRoute) {
  if (!route.accountId || !route.threadId) return false
  if (!openListeners.size) pendingOpen = route
  else for (const listener of openListeners) listener(route)
  return true
}

export function subscribeNotificationOpens(listener: RouteListener) {
  openListeners.add(listener)
  if (pendingOpen) {
    const route = pendingOpen
    pendingOpen = null
    queueMicrotask(() => openListeners.has(listener) && listener(route))
  }
  return () => {
    openListeners.delete(listener)
  }
}

/** One banner per occurrence: a second alert for it replaces the first instead of stacking. */
export const eventNotificationIdentifier = ({ eventId, occurrenceStart }: EventRoute) => `jefi-event:${eventId}@${occurrenceStart}`

/** Like dispatchNotificationOpen, for a reminder's banner. */
export function dispatchEventOpen(route: EventRoute) {
  if (!route.eventId || !Number.isFinite(route.occurrenceStart)) return false
  if (!eventListeners.size) pendingEventOpen = route
  else for (const listener of eventListeners) listener(route)
  return true
}

export function subscribeEventOpens(listener: EventListener) {
  eventListeners.add(listener)
  if (pendingEventOpen) {
    const route = pendingEventOpen
    pendingEventOpen = null
    queueMicrotask(() => eventListeners.has(listener) && listener(route))
  }
  return () => {
    eventListeners.delete(listener)
  }
}

/** Location installed by scripts/bundle.ts; exposed for a platform-independent path test. */
export function notificationHelperPath(execPath = process.execPath) {
  return resolve(dirname(execPath), '..', 'Frameworks', 'libJefiNotifications.dylib')
}

const openNotificationLibrary = (path: string) =>
  dlopen(path, {
    jefi_notifications_start: { args: [FFIType.ptr], returns: FFIType.void },
    jefi_notifications_show: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring],
      returns: FFIType.bool,
    },
    jefi_notifications_set_event_callback: { args: [FFIType.ptr], returns: FFIType.void },
    jefi_notifications_show_event: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring],
      returns: FFIType.bool,
    },
    jefi_notifications_authorization_status: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
    jefi_notifications_request_authorization: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
  })

type NotificationLibrary = ReturnType<typeof openNotificationLibrary>

let nativeLibrary: NotificationLibrary | null = null
let nativeOpenCallback: JSCallback | null = null
let nativeEventCallback: JSCallback | null = null
let nativeAuthorizationCallback: JSCallback | null = null

const stringAt = (pointer: Pointer | null) => (pointer ? new CString(pointer).toString() : '')
const cString = (value: string) => Buffer.from(`${value}\0`, 'utf8')

function initializeNativeHelper() {
  if (!notificationsAvailable || nativeLibrary) return nativeLibrary
  const path = notificationHelperPath()
  if (!existsSync(path)) return null
  try {
    const library = openNotificationLibrary(path)
    // The native bridge guarantees this callback runs on the app's main queue. Convert its copied
    // UTF-8 strings immediately: the pointers are valid only for the duration of this call.
    const callback = new JSCallback(
      (accountPointer: Pointer | null, threadPointer: Pointer | null) => {
        dispatchNotificationOpen({ accountId: stringAt(accountPointer), threadId: stringAt(threadPointer) })
      },
      { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    )
    const eventCallback = new JSCallback(
      (eventPointer: Pointer | null, startPointer: Pointer | null) => {
        dispatchEventOpen({ eventId: stringAt(eventPointer), occurrenceStart: Number(stringAt(startPointer)) })
      },
      { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    )
    library.symbols.jefi_notifications_set_event_callback(eventCallback.ptr)
    library.symbols.jefi_notifications_start(callback.ptr)
    const authorizationCallback = new JSCallback((token: number, status: number) => permissions.deliver(token, status), {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.void,
    })
    nativeLibrary = library
    nativeAuthorizationCallback = authorizationCallback
    nativeOpenCallback = callback
    nativeEventCallback = eventCallback
    return library
  } catch {
    nativeOpenCallback?.close()
    nativeOpenCallback = null
    nativeAuthorizationCallback?.close()
    nativeAuthorizationCallback = null
    nativeEventCallback?.close()
    nativeEventCallback = null
    nativeLibrary = null
    return null
  }
}

/** Shows a banner. Silent if anything goes wrong: a missed notification must never break the app. */
export function showNotification(notification: MailNotification) {
  if (!notificationsAvailable) return false
  try {
    const library = initializeNativeHelper()
    if (library) {
      return library.symbols.jefi_notifications_show(
        cString(notificationIdentifier(notification)),
        cString(notification.title),
        cString(notification.subtitle ?? ''),
        cString(notification.body),
        cString(notification.accountId),
        cString(notification.threadId),
        cString(notificationImageSpec(notification.image)),
        cString(notification.copy ?? ''),
      )
    }
    Bun.spawn(['osascript', '-e', notificationScript(notification)], { stdout: 'ignore', stderr: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A reminder's banner; clicking it opens the occurrence (subscribeEventOpens). Silent on failure. */
export function showEventNotification(notification: EventNotification) {
  if (!notificationsAvailable) return false
  try {
    const library = initializeNativeHelper()
    if (library) {
      return library.symbols.jefi_notifications_show_event(
        cString(eventNotificationIdentifier(notification)),
        cString(notification.title),
        cString(notification.subtitle ?? ''),
        cString(notification.body),
        cString(notification.eventId),
        cString(String(notification.occurrenceStart)),
        cString(notificationImageSpec(notification.image)),
      )
    }
    Bun.spawn(['osascript', '-e', notificationScript(notification)], { stdout: 'ignore', stderr: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Permission, asked for on purpose by the onboarding screen and Settings rather than on the first
// banner. The helper answers asynchronously on the main queue with the token it was given.
// ---------------------------------------------------------------------------

export type NotificationPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable'

/** The helper's status code: provisional and ephemeral both deliver banners, so they count as granted. */
export function permissionFromStatus(code: number): NotificationPermission {
  if (code === 0) return 'undetermined'
  if (code === 1) return 'denied'
  if (code >= 2 && code <= 4) return 'granted'
  return 'unavailable'
}

type PermissionNative = { status: (token: number) => boolean; request: (token: number) => boolean }

/**
 * Matches the helper's callbacks to their promises. A status that never arrives (no run loop, a
 * helper that can't reach Notification Center) settles as 'unavailable' after `timeoutMs`; a request
 * waits for as long as the person takes to answer the system prompt.
 */
export function createPermissionBridge(native: () => PermissionNative | null, timeoutMs = 4000) {
  const waiting = new Map<number, (code: number) => void>()
  let next = 1
  const ask = (kind: keyof PermissionNative, timeout: number | null) =>
    new Promise<number>((settle) => {
      const helper = native()
      if (!helper) return settle(-1)
      const token = next++
      const timer = timeout === null ? null : setTimeout(() => waiting.delete(token) && settle(-1), timeout)
      waiting.set(token, (code) => {
        if (timer) clearTimeout(timer)
        settle(code)
      })
      let started = false
      try {
        started = helper[kind](token)
      } catch {}
      if (!started) waiting.get(token)?.(-1)
    })
  return {
    status: async () => permissionFromStatus(await ask('status', timeoutMs)),
    request: async (): Promise<NotificationPermission> => {
      const code = await ask('request', null)
      // An error from the prompt says nothing about the setting itself: read it back.
      return code < 0 ? permissionFromStatus(await ask('status', timeoutMs)) : permissionFromStatus(code)
    },
    deliver(token: number, code: number) {
      const settle = waiting.get(token)
      waiting.delete(token)
      settle?.(code)
    },
  }
}

const permissions = createPermissionBridge(() => {
  const library = initializeNativeHelper()
  const callback = nativeAuthorizationCallback?.ptr
  if (!library || !callback) return null
  return {
    status: (token) => library.symbols.jefi_notifications_authorization_status(callback, token),
    request: (token) => library.symbols.jefi_notifications_request_authorization(callback, token),
  }
})

/** Whether Jefi may show banners. 'unavailable' when the helper isn't loadable (an unbundled dev run). */
export const notificationPermission = (): Promise<NotificationPermission> =>
  notificationsAvailable ? permissions.status() : Promise.resolve('unavailable')

/** Shows the system prompt when the question is still open; otherwise reports the standing answer. */
export const requestNotificationPermission = (): Promise<NotificationPermission> =>
  notificationsAvailable ? permissions.request() : Promise.resolve('unavailable')

/** The running app's bundle id from its Info.plist, or Jefi's release id. */
export function appBundleId(execPath = process.execPath): string {
  try {
    const plist = readFileSync(resolve(dirname(execPath), '..', 'Info.plist'), 'utf8')
    const id = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
    if (id) return id
  } catch {}
  return 'app.jefi.mail'
}

export const notificationSettingsUrl = (bundleId: string) =>
  `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(bundleId)}`
export const NOTIFICATIONS_PANE_URL = 'x-apple.systempreferences:com.apple.preference.notifications'

/** Jefi's page in System Settings › Notifications, or the Notifications pane if that link fails. */
export async function openNotificationSettings() {
  if (!notificationsAvailable) return false
  try {
    const direct = Bun.spawn(['open', notificationSettingsUrl(appBundleId())], { stdout: 'ignore', stderr: 'ignore' })
    if ((await direct.exited) === 0) return true
    return (await Bun.spawn(['open', NOTIFICATIONS_PANE_URL], { stdout: 'ignore', stderr: 'ignore' }).exited) === 0
  } catch {
    return false
  }
}

// Install the delegate during module initialization, before a notification can activate the app.
initializeNativeHelper()
