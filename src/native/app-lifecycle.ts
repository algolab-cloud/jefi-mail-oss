import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CString, dlopen, FFIType, JSCallback, type Pointer } from 'bun:ffi'
import { available, cls, msg, msgBool, msgIndex, msgInt, msgLong, sel, type Id } from './objc'

// ---------------------------------------------------------------------------
// Keeping Jefi alive without its window. GPUIX exits the process when its last window closes, which
// would stop sync and new-mail banners, so with the menu bar item on the close button hides the
// window instead; the Dock, a relaunch or the menu bar panel shows it again.
//
// Jefi.app ships scripts/native/lifecycle.m for this. From source (`bun run dev`) there is no helper,
// so the same two methods are replaced from JS: the spike in docs/menu-bar-architecture.md showed it
// works, but the Objective-C helper is the one that ships.
// ---------------------------------------------------------------------------

export type ClosePlan = { action: 'hide' | 'quit'; hideDock: boolean }

/** What closing the window does: with the menu bar item it hides (and maybe leaves the Dock); without, Jefi quits as before. */
export function closePlan(settings: { menuBar: boolean; hideDockWhenClosed: boolean }): ClosePlan {
  return settings.menuBar ? { action: 'hide', hideDock: settings.hideDockWhenClosed } : { action: 'quit', hideDock: false }
}

/** Location installed by scripts/bundle.ts; JEFI_LIFECYCLE_HELPER points a script at a freshly built one. */
export function lifecycleHelperPath(execPath = process.execPath, env: Record<string, string | undefined> = process.env) {
  return env.JEFI_LIFECYCLE_HELPER || resolve(dirname(execPath), '..', 'Frameworks', 'libJefiLifecycle.dylib')
}

const openHelper = (path: string) =>
  dlopen(path, {
    jefi_lifecycle_install: { args: [], returns: FFIType.bool },
    jefi_lifecycle_configure: { args: [FFIType.bool, FFIType.bool], returns: FFIType.void },
    jefi_lifecycle_show: { args: [], returns: FFIType.void },
    jefi_lifecycle_window_visible: { args: [], returns: FFIType.bool },
    jefi_lifecycle_close: { args: [], returns: FFIType.void },
    jefi_lifecycle_quit: { args: [], returns: FFIType.void },
  })

/** The same five calls, from the helper or from the JS fallback. */
type Backend = {
  install: () => boolean
  configure: (plan: ClosePlan) => void
  show: () => void
  visible: () => boolean
  close: () => void
  quit: () => void
}

function helperBackend(): Backend | null {
  const path = lifecycleHelperPath()
  if (!existsSync(path)) return null
  try {
    const { symbols } = openHelper(path)
    return {
      install: () => symbols.jefi_lifecycle_install(),
      configure: (plan) => symbols.jefi_lifecycle_configure(plan.action === 'hide', plan.hideDock),
      show: () => symbols.jefi_lifecycle_show(),
      visible: () => symbols.jefi_lifecycle_window_visible(),
      close: () => symbols.jefi_lifecycle_close(),
      quit: () => symbols.jefi_lifecycle_quit(),
    }
  } catch {
    return null
  }
}

const POLICY_REGULAR = 0
const POLICY_ACCESSORY = 1

/** Development fallback: lifecycle.m's logic over bun:ffi (callbacks arrive on the main thread from the run loop). */
function jsBackend(): Backend {
  const runtime = dlopen('/usr/lib/libobjc.A.dylib', {
    object_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
    class_getName: { args: [FFIType.ptr], returns: FFIType.ptr },
    class_replaceMethod: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
  }).symbols
  const app = () => msg(cls('NSApplication'), 'sharedApplication')
  const className = (object: Id) => new CString(runtime.class_getName(runtime.object_getClass(object))!).toString()
  let window: Id = null
  let plan: ClosePlan = { action: 'quit', hideDock: false }
  const keep: JSCallback[] = []
  const visible = () => !!window && msgInt(window, 'isVisible') === 1
  const dockPolicy = () => {
    const policy = window && !visible() && plan.action === 'hide' && plan.hideDock ? POLICY_ACCESSORY : POLICY_REGULAR
    if (msgInt(app(), 'activationPolicy') !== policy) msgLong(app(), 'setActivationPolicy:', policy)
  }
  const show = () => {
    if (!window) return
    if (msgInt(app(), 'activationPolicy') !== POLICY_REGULAR) msgLong(app(), 'setActivationPolicy:', POLICY_REGULAR)
    msg(window, 'makeKeyAndOrderFront:', null)
    msgBool(app(), 'activateIgnoringOtherApps:', true)
  }
  return {
    install() {
      if (window) return true
      const windows = msg(app(), 'windows')
      for (let i = 0; i < msgInt(windows, 'count') && !window; i++) {
        const candidate = msgIndex(windows, 'objectAtIndex:', i)
        if (className(candidate).includes('GPUI')) window = candidate
      }
      const delegate = window && msg(window, 'delegate')
      if (!window || !delegate) {
        window = null
        return false
      }
      const shouldClose = new JSCallback(
        (_self: Pointer, _cmd: Pointer, sender: Pointer) => {
          if (sender !== window || plan.action !== 'hide') return true
          msg(sender, 'orderOut:', null)
          dockPolicy()
          return false
        },
        { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      )
      const reopen = new JSCallback(
        () => {
          if (!visible()) show()
          return true
        },
        { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.bool },
      )
      keep.push(shouldClose, reopen)
      runtime.class_replaceMethod(runtime.object_getClass(delegate), sel('windowShouldClose:'), shouldClose.ptr!, Buffer.from('c@:@\0'))
      const appDelegate = msg(app(), 'delegate')
      if (appDelegate) runtime.class_replaceMethod(runtime.object_getClass(appDelegate), sel('applicationShouldHandleReopen:hasVisibleWindows:'), reopen.ptr!, Buffer.from('c@:@c\0'))
      return true
    },
    configure(next) {
      plan = next
      if (window && !visible() && plan.action !== 'hide') show()
      else dockPolicy()
    },
    show,
    visible,
    close: () => void (window && msg(window, 'performClose:', null)),
    quit: () => void msg(app(), 'terminate:', null),
  }
}

let backend: Backend | null = null
let installed = false
let pending: ClosePlan | null = null
let retry: ReturnType<typeof setTimeout> | null = null
const shownListeners = new Set<() => void>()

function ensureBackend(): Backend | null {
  if (!available) return null
  try {
    backend ??= helperBackend() ?? jsBackend()
  } catch {
    return null
  }
  return backend
}

/** Which implementation is live ('helper' in Jefi.app), for scripts that check both. */
export const lifecycleBackend = () => (!backend ? 'none' : existsSync(lifecycleHelperPath()) ? 'helper' : 'js')

/**
 * Applies what closing the window does. Safe to call before the window exists (it retries until
 * GPUIX has made it) and on every settings change.
 */
export function configureLifecycle(plan: ClosePlan) {
  const native = ensureBackend()
  if (!native) return
  pending = plan
  if (!installed) {
    installed = native.install()
    if (!installed) {
      retry ??= setTimeout(() => {
        retry = null
        if (pending) configureLifecycle(pending)
      }, 250)
      return
    }
  }
  native.configure(plan)
}

/** Brings the window back (from the menu bar panel, or anywhere the app wants to be seen). */
export function showMainWindow() {
  const native = ensureBackend()
  if (!native || !installed) return
  native.show()
  for (const listener of shownListeners) listener()
}

/** Called after showMainWindow: macOS can reset the Dock tile when the Dock icon comes back. */
export function onMainWindowShown(listener: () => void) {
  shownListeners.add(listener)
  return () => void shownListeners.delete(listener)
}

export const mainWindowVisible = () => (installed ? (backend?.visible() ?? true) : true)

/** Presses the window's close button, as the person would (for scripts). */
export const closeMainWindow = () => void (installed && backend?.close())

/** Quits for real: the menu bar panel's Quit. */
export function quitApp() {
  const native = ensureBackend()
  if (native) native.quit()
  // terminate: normally never returns; this covers a process with no AppKit app.
  setTimeout(() => process.exit(0), 1000)
}
