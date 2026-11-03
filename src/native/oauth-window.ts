import type { SignInBrowser, SignInPlatform, SignInUserAgent } from '../theme'
import { alloc, available, cls, loadWebKit, makeObject, msg, msgBool, msgInitWindow, msgRectObj, nsString, release, type Id } from './objc'

// ---------------------------------------------------------------------------
// The provider's sign-in page in a window of Jefi's own, instead of a tab in the default browser.
//
// A plain WebKit view in a titled window: page JavaScript is on (sign-in pages need it), cookies
// live only as long as the window (a non-persistent store, so accounts don't bleed into each other),
// and the redirect back to the engine's loopback server loads right here. Closing the window
// cancels the sign-in.
// ---------------------------------------------------------------------------

export const inAppSignInAvailable = available

const STYLE = 1 | 2 | 8 // titled, closable, resizable
const BACKING_BUFFERED = 2
/** Popular desktop browsers and systems, for the Settings selectors. */
export const SIGN_IN_BROWSERS: Array<{ value: SignInBrowser; label: string; version: string }> = [
  { value: 'safari', label: 'Safari', version: '18.0' },
  { value: 'chrome', label: 'Chrome', version: '131.0.0.0' },
  { value: 'edge', label: 'Edge', version: '131.0.0.0' },
  { value: 'firefox', label: 'Firefox', version: '133.0' },
]
export const SIGN_IN_PLATFORMS: Array<{ value: SignInPlatform; label: string }> = [
  { value: 'mac', label: 'macOS' },
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
]
const SAFARI_WEBKIT = '605.1.15'

/** The platform token a browser reports (Firefox writes the macOS version with dots). */
export function platformToken(platform: SignInPlatform = 'mac', family: SignInBrowser = 'safari') {
  if (platform === 'windows') return 'Windows NT 10.0; Win64; x64'
  if (platform === 'linux') return 'X11; Linux x86_64'
  return family === 'firefox' ? 'Macintosh; Intel Mac OS X 10.15' : 'Macintosh; Intel Mac OS X 10_15_7'
}
export const browserVersion = (family: SignInBrowser = 'safari') => SIGN_IN_BROWSERS.find((b) => b.value === family)!.version
export const webkitVersion = (family: SignInBrowser = 'safari') => (family === 'safari' ? SAFARI_WEBKIT : '537.36')

/**
 * Identity providers can refuse sign-in inside embedded views they recognise, so the window presents
 * as a regular desktop browser (Safari on macOS unless Settings says otherwise). Each free-text part
 * comes from Settings, then the environment, then the preset:
 *   custom   JEFI_OAUTH_USER_AGENT   the whole string (wins over everything else)
 *   os       JEFI_OAUTH_UA_OS        platform token, e.g. "Macintosh; Intel Mac OS X 10_15_7"
 *   webkit   JEFI_OAUTH_UA_WEBKIT    WebKit build (Safari, Chrome, Edge)
 *   browser  JEFI_OAUTH_UA_BROWSER   browser version, e.g. "18.0"
 *   suffix   JEFI_OAUTH_UA_SUFFIX    anything appended at the end, e.g. "Jefi/0.1"
 */
export function signInUserAgent(parts: Partial<SignInUserAgent> = {}, env: Record<string, string | undefined> = process.env) {
  const pick = (value: string | undefined, key: string) => value?.trim() || env[key]?.trim() || ''
  const custom = pick(parts.custom, 'JEFI_OAUTH_USER_AGENT')
  if (custom) return custom
  const family = parts.family ?? 'safari'
  const os = pick(parts.os, 'JEFI_OAUTH_UA_OS') || platformToken(parts.platform, family)
  const webkit = pick(parts.webkit, 'JEFI_OAUTH_UA_WEBKIT') || webkitVersion(family)
  const version = pick(parts.browser, 'JEFI_OAUTH_UA_BROWSER') || browserVersion(family)
  const suffix = pick(parts.suffix, 'JEFI_OAUTH_UA_SUFFIX')
  const base =
    family === 'firefox'
      ? `Mozilla/5.0 (${os}; rv:${version}) Gecko/20100101 Firefox/${version}`
      : family === 'safari'
        ? `Mozilla/5.0 (${os}) AppleWebKit/${webkit} (KHTML, like Gecko) Version/${version} Safari/${webkit}`
        : `Mozilla/5.0 (${os}) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${version} Safari/${webkit}${family === 'edge' ? ` Edg/${version}` : ''}`
  return suffix ? `${base} ${suffix}` : base
}

let window: Id = null
let view: Id = null
let delegate: Id = null
let onClosed: (() => void) | null = null

/** Opens (or reuses) the sign-in window on `url`; `closed` runs if the person closes it themselves. */
export function openSignInWindow(url: string, closed: () => void, userAgent = signInUserAgent()) {
  onClosed = closed
  if (!window) {
    loadWebKit()
    const config = msg(alloc('WKWebViewConfiguration'), 'init')
    msg(config, 'setWebsiteDataStore:', msg(cls('WKWebsiteDataStore'), 'nonPersistentDataStore'))
    view = msgRectObj(alloc('WKWebView'), 'initWithFrame:configuration:', 0, 0, 520, 680, config)
    release(config)
    msg(view, 'setCustomUserAgent:', nsString(userAgent))

    window = msgInitWindow(alloc('NSWindow'), 0, 0, 520, 680, STYLE, BACKING_BUFFERED)
    msgBool(window, 'setReleasedWhenClosed:', false)
    msg(window, 'setTitle:', nsString('Sign in'))
    msg(window, 'setContentView:', view)
    delegate ??= makeObject('JefiSignInWindowDelegate', 'NSWindowDelegate', [
      { selector: 'windowWillClose:', types: 'v@:@', args: 1, fn: teardown },
    ])
    msg(window, 'setDelegate:', delegate)
    msg(window, 'center')
  }
  msg(view, 'loadRequest:', msg(cls('NSURLRequest'), 'requestWithURL:', msg(cls('NSURL'), 'URLWithString:', nsString(url))))
  msg(window, 'makeKeyAndOrderFront:', null)
  msgBool(msg(cls('NSApplication'), 'sharedApplication'), 'activateIgnoringOtherApps:', true)
}

/** The sign-in finished (or failed): close the window without reporting a cancel. */
export function closeSignInWindow() {
  if (!window) return
  onClosed = null
  msg(window, 'close')
}

function teardown() {
  const w = window
  const web = view
  window = null
  view = null
  const closed = onClosed
  onClosed = null
  // Let AppKit finish closing before the objects go.
  queueMicrotask(() => {
    msg(w, 'setDelegate:', null)
    msg(w, 'setContentView:', null)
    release(web)
    release(w)
  })
  closed?.()
}
