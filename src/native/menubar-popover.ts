import { alloc, available, callBlockWithInt, cls, fromNSString, loadWebKit, makeObject, msg, msgBool, msgBoolResult, msgGetValue, msgIndex, msgInt, msgLong, msgRectObj, msgShowRelative, msgSize, nsString, release, type Id } from './objc'

// ---------------------------------------------------------------------------
// The menu bar panel: an NSPopover (transient, so an outside click or Esc closes it, with the system's
// material and arrow: Liquid Glass on macOS 26+) holding a transparent WKWebView. The page is our own string loaded with
// no base URL; every navigation away from it is cancelled. Its messages arrive through a
// WKScriptMessageHandler on the main thread and are handed over as raw strings for the caller to parse.
// ---------------------------------------------------------------------------

export const PANEL_WIDTH = 344
const MIN_HEIGHT = 200
const MAX_HEIGHT = 760
const TRANSIENT = 1
/** Below the status item (the bar's view is flipped, so min-Y is the bottom edge). */
const MIN_Y_EDGE = 1
const POLICY_CANCEL = 0
const POLICY_ALLOW = 1

type Popover = { popover: Id; web: Id }

let panel: Popover | null = null
let onMessage: ((raw: string) => void) | null = null
let onClosed: (() => void) | null = null
let height = 560

function build(): Popover | null {
  loadWebKit()
  const config = msg(alloc('WKWebViewConfiguration'), 'init')
  // Nothing to keep between openings: no cookies, caches or storage on disk.
  msg(config, 'setWebsiteDataStore:', msg(cls('WKWebsiteDataStore'), 'nonPersistentDataStore'))
  const handler = makeObject('JefiMenuBarMessages', 'WKScriptMessageHandler', [
    {
      selector: 'userContentController:didReceiveScriptMessage:',
      types: 'v@:@@',
      args: 2,
      fn: (_self, _cmd, _controller, message) => {
        const body = msg(message, 'body')
        // Only strings: the page posts JSON text, anything else is ignored.
        if (body && msgBoolResult(body, 'isKindOfClass:', cls('NSString'))) onMessage?.(fromNSString(body))
      },
    },
  ])
  msg(msg(config, 'userContentController'), 'addScriptMessageHandler:name:', handler, nsString('jefi'))
  const web = msgRectObj(alloc('WKWebView'), 'initWithFrame:configuration:', 0, 0, PANEL_WIDTH, height, config)
  release(config)
  if (!web) return null
  // Transparent, under-page area included, so the popover's material shows through.
  msg(web, 'setValue:forKey:', msg(cls('NSNumber'), 'numberWithBool:', null), nsString('drawsBackground'))
  msg(web, 'setUnderPageBackgroundColor:', msg(cls('NSColor'), 'clearColor'))
  const delegate = makeObject('JefiMenuBarNavigation', 'WKNavigationDelegate', [
    {
      selector: 'webView:decidePolicyForNavigationAction:decisionHandler:',
      types: 'v@:@@@?',
      args: 3,
      fn: (_self, _cmd, _web, action, decide) => {
        let url = ''
        try {
          url = fromNSString(msg(msg(msg(action, 'request'), 'URL'), 'absoluteString'))
        } finally {
          callBlockWithInt(decide!, url === 'about:blank' ? POLICY_ALLOW : POLICY_CANCEL)
        }
      },
    },
  ])
  msg(web, 'setNavigationDelegate:', delegate)
  const controller = msg(alloc('NSViewController'), 'init')
  msg(controller, 'setView:', web)
  const popover = msg(alloc('NSPopover'), 'init')!
  msgLong(popover, 'setBehavior:', TRANSIENT)
  msgBool(popover, 'setAnimates:', true)
  msgSize(popover, 'setContentSize:', PANEL_WIDTH, height)
  msg(popover, 'setContentViewController:', controller)
  const popoverDelegate = makeObject('JefiMenuBarPopoverDelegate', 'NSPopoverDelegate', [
    { selector: 'popoverDidClose:', types: 'v@:@', args: 1, fn: () => onClosed?.() },
  ])
  msg(popover, 'setDelegate:', popoverDelegate)
  return { popover, web }
}

export const popoverAvailable = available

export function configurePanel(handlers: { onMessage: (raw: string) => void; onClosed: () => void }) {
  onMessage = handlers.onMessage
  onClosed = handlers.onClosed
}

export const panelShown = () => !!panel && msgInt(panel.popover, 'isShown') === 1

/**
 * macOS 26 and later draw popovers in Liquid Glass. NSGlassEffectView arrives with it, so its class
 * is the check; earlier systems get the older vibrant material, which the page covers with its own
 * near-opaque background for contrast.
 */
export const glassAvailable = () => available && !!cls('NSGlassEffectView')

type Look = 'light' | 'dark'
let forced: Look | null = null
const appearanceFor = (look: Look | null) => (look ? msg(cls('NSAppearance'), 'appearanceNamed:', nsString(look === 'dark' ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua')) : null)

/**
 * Opens the panel under `button` with `html`. The popover keeps the appearance it inherits from the
 * menu bar, like the system's own extras, and the page follows it through prefers-color-scheme, live
 * as the system appearance changes. Nothing is painted under the page: the glass is the background.
 */
export function showPanel(button: Id, html: string) {
  if (!available) return false
  panel ??= build()
  if (!panel) return false
  msg(panel.popover, 'setAppearance:', appearanceFor(forced))
  msg(panel.web, 'loadHTMLString:baseURL:', nsString(html), null)
  msgShowRelative(panel.popover, 0, 0, 0, 0, button, MIN_Y_EDGE)
  // An accessory or background app has to come forward for the field to take typing.
  msgBool(msg(cls('NSApplication'), 'sharedApplication'), 'activateIgnoringOtherApps:', true)
  msg(msg(panel.web, 'window'), 'makeFirstResponder:', panel.web)
  return true
}

/** The appearance the panel is drawn in, as AppKit resolved it. */
export const panelAppearance = (): Look | '' => (panel ? (/Dark/.test(fromNSString(msg(msg(panel.web, 'effectiveAppearance'), 'name'))) ? 'dark' : 'light') : '')

/** For screenshots only: pins the panel to one appearance (null follows the menu bar again), live. */
export function forcePanelAppearance(look: Look | null) {
  forced = look
  if (panel) msg(panel.popover, 'setAppearance:', appearanceFor(look))
}

/** Closes at once: an action that opens the window shouldn't wait for the fade. */
export function closePanel() {
  if (!panel || !panelShown()) return
  msgBool(panel.popover, 'setAnimates:', false)
  msg(panel.popover, 'close')
  msgBool(panel.popover, 'setAnimates:', true)
}

/** Fits the popover to the page's measured height (within the screen-friendly bounds). */
export function setPanelHeight(next: number) {
  const clamped = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, next)))
  if (!panel || clamped === height) return
  height = clamped
  msgSize(panel.popover, 'setContentSize:', PANEL_WIDTH, height)
}

/** Runs one of the page's own functions with a JSON argument (never page-supplied code). */
export function callPanel(fn: 'jefiReplace', argument: string) {
  if (!panel || !panelShown()) return
  msg(panel.web, 'evaluateJavaScript:completionHandler:', nsString(`window.${fn} && window.${fn}(${JSON.stringify(argument)})`), null)
}

/** The popover's window, for screenshots: its number is what `screencapture -l` takes. */
export const panelWindowNumber = () => (panel && panelShown() ? msgInt(msg(panel.web, 'window'), 'windowNumber') : 0)

/** The popover's window in screen points, top-left origin (what `screencapture -R` takes), for screenshots of the glass in place. */
export function panelScreenFrame(): number[] | null {
  if (!panel || !panelShown()) return null
  const rect = (object: Id) => {
    const value = object && msg(object, 'valueForKey:', nsString('frame'))
    if (!value) return null
    const bytes = new Float64Array(4)
    msgGetValue(value, 'getValue:size:', new Uint8Array(bytes.buffer))
    return [...bytes]
  }
  const frame = rect(msg(panel.web, 'window'))
  // Global coordinates flip against the primary screen (the first), whichever display the panel is on.
  const screen = rect(msgIndex(msg(cls('NSScreen'), 'screens'), 'objectAtIndex:', 0))
  return frame && screen ? [frame[0]!, screen[3]! - frame[1]! - frame[3]!, frame[2]!, frame[3]!] : null
}

/** The screen the popover is on, in the same top-left points plus its backing scale, so a screenshot can tell a Retina display from a 1x one. */
export function panelScreen(): number[] | null {
  if (!panel || !panelShown()) return null
  const screen = msg(msg(panel.web, 'window'), 'screen')
  if (!screen) return null
  const rect = (object: Id) => {
    const value = object && msg(object, 'valueForKey:', nsString('frame'))
    if (!value) return null
    const bytes = new Float64Array(4)
    msgGetValue(value, 'getValue:size:', new Uint8Array(bytes.buffer))
    return [...bytes]
  }
  const frame = rect(screen)
  const primary = rect(msgIndex(msg(cls('NSScreen'), 'screens'), 'objectAtIndex:', 0))
  const scale = msgInt(msg(screen, 'valueForKey:', nsString('backingScaleFactor')), 'integerValue')
  return frame && primary ? [frame[0]!, primary[3]! - frame[1]! - frame[3]!, frame[2]!, frame[3]!, scale] : null
}
