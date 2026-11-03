import type { Pointer } from 'bun:ffi'
import { appendFileSync } from 'node:fs'
import { onOverlaysChange, overlaysOpen } from '../overlays'
import { snapshotMailWebView } from './mail-snapshot'
import { alloc, available, callBlockWithInt, cls, fromNSString, loadWebKit, makeObject, msg, msgBool, msgBoolResult, msgGetValue, msgIndex, msgInt, msgRect, msgRectObj, nsString, release, msgDouble } from './objc'

// ---------------------------------------------------------------------------
// One system WebKit view for reading HTML mail in "Full" mode, laid over the reading pane.
//
// Lightweight by design: WebKit ships with macOS (nothing added to the package), and there is
// only ever one view, reused from message to message and released when Full mode closes.
// Safe by design: page JavaScript is off, a Content-Security-Policy allows only images and inline
// styles (no scripts, frames, fonts or fetches), and all navigation is refused — clicked links
// open in the default browser instead. Remote images stay out of that policy until the person asks
// for them, so a tracking pixel never tells the sender the mail was opened.
// ---------------------------------------------------------------------------

export const fullRenderingAvailable = available

type Frame = { x: number; y: number; width: number; height: number }
type LinkPosition = { x: number; y: number }
type SnapshotIdentity = { generation: number; web: Pointer | null; page: string; navigation: Pointer | null }

const WK_NAVIGATION_LINK = 0
const POLICY_CANCEL = 0
const POLICY_ALLOW = 1

let view: Pointer | null = null
/** Clips the web view to the reader's scroll area, so it never covers the header or composer. */
let clipper: Pointer | null = null
/** Placed and meant to be seen (independent of popovers covering it for a moment). */
let placed = false
let delegate: Pointer | null = null
let shown = ''
let loadedShown = ''
let expectedNavigation: Pointer | null = null
let onLink: ((url: string, position?: LinkPosition) => void) | null = null
let positionedWindowHeight = 0
let positionedFrame: Frame | null = null
let positionedGeometry = ''
let frozenSnapshot: string | null = null
let snapshotShown = ''
let snapshotGeneration = 0
let releaseSnapshotImage: ((source: string) => boolean) | null = null
let snapshotRevision = 0
const snapshotListeners = new Set<() => void>()
/** Whether the clipper is currently hidden, so an overlay can tell if WebKit is on screen. */
let clipperHidden = false
/** Generation of a capture started while WebKit was on screen; it stays up until the image paints. */
let visibleCaptureGeneration = -1
/** Page already given a capture attempt while hidden under this overlay session. */
let hiddenCaptureTried = ''
let linkReviewBesideWeb = false

const MOUSE_EVENT_TYPES = new Set([1, 2, 3, 4]) // left/right mouse down/up

export const snapshotBoundsAllowed = (width: number, height: number) =>
  [width, height].every(Number.isFinite) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 4_000_000

/** A capture is usable only for the exact still-visible WK navigation that requested it. */
export function snapshotIdentityMatches(requested: SnapshotIdentity, current: SnapshotIdentity & { loadedPage: string; placed: boolean }) {
  return current.placed && requested.generation === current.generation && requested.web === current.web &&
    requested.page === current.page && requested.navigation === current.navigation && current.loadedPage === requested.page
}

/**
 * The one visibility rule for the native view. GPUIX overlays draw underneath it, so while any is
 * open WebKit must be hidden (a frozen snapshot, or a blank area, stands in), except when a link
 * review deliberately sits beside it, or for the few ms a capture started on screen needs to paint.
 */
export function mailViewHidden(state: { placed: boolean; overlays: boolean; linkReviewBesideWeb: boolean; capturingOnScreen: boolean }) {
  if (!state.placed) return true
  return state.overlays && !state.linkReviewBesideWeb && !state.capturingOnScreen
}

/** Converts AppKit's bottom-left window point to GPUIX's top-left point beside the click. */
export function linkPositionFromWindowPoint(eventType: number, x: number, y: number, windowHeight: number): LinkPosition | null {
  if (!MOUSE_EVENT_TYPES.has(eventType) || ![x, y, windowHeight].every(Number.isFinite) || windowHeight <= 0) return null
  return { x: x + 8, y: windowHeight - y + 12 }
}

/** Current mouse event location without calling a struct-return objc_msgSend from Bun FFI. */
function currentLinkPosition(): LinkPosition | null {
  try {
    const event = msg(msg(cls('NSApplication'), 'sharedApplication'), 'currentEvent')
    if (!event) return null
    const type = msgInt(event, 'type')
    if (!MOUSE_EVENT_TYPES.has(type)) return null
    // KVC boxes NSPoint in an NSValue. Copy its two CGFloat (double on arm64) fields into JS memory.
    const point = msg(event, 'valueForKey:', nsString('locationInWindow'))
    if (!point) return null
    const bytes = Buffer.alloc(16)
    msgGetValue(point, 'getValue:size:', bytes)
    return linkPositionFromWindowPoint(type, bytes.readDoubleLE(0), bytes.readDoubleLE(8), positionedWindowHeight)
  } catch {
    // Position is presentation only. URL review must still open if AppKit has no usable event.
    return null
  }
}

/** GPUIX must evict a private-message screenshot after its image node has left the native tree. */
export function setMailSnapshotImageReleaser(releaseImage: ((source: string) => boolean) | null) {
  releaseSnapshotImage = releaseImage
}

export const mailSnapshotRevision = () => snapshotRevision
export function subscribeMailSnapshots(listener: () => void) {
  snapshotListeners.add(listener)
  return () => void snapshotListeners.delete(listener)
}

function snapshotChanged() {
  snapshotRevision++
  for (const listener of snapshotListeners) listener()
}

function releaseAfterUnmount(source: string, attempt = 0) {
  setTimeout(() => {
    if (frozenSnapshot === source) return
    try {
      if (releaseSnapshotImage?.(source)) return
    } catch {
      return
    }
    // A retained image refuses eviction. A few frame-spaced retries cover a delayed React/GPUI
    // commit while remaining bounded if the URL was never decoded.
    if (attempt < 4) releaseAfterUnmount(source, attempt + 1)
  }, 34)
}

function discardFrozenSnapshot() {
  const source = frozenSnapshot
  frozenSnapshot = null
  snapshotShown = ''
  if (source) {
    snapshotChanged()
    releaseAfterUnmount(source)
  }
}

function setFrozenSnapshot(source: string, page: string) {
  discardFrozenSnapshot()
  frozenSnapshot = source
  snapshotShown = page
  snapshotChanged()
}

function failedSnapshotPosition(pointer: LinkPosition | null): LinkPosition | undefined {
  if (!positionedFrame) return pointer ?? undefined
  return { x: Math.max(8, positionedFrame.x - 318), y: pointer?.y ?? positionedFrame.y + 28 }
}

function beginLinkReview(url: string) {
  const web = view
  const page = shown
  const navigation = expectedNavigation
  const handler = onLink
  const pointer = currentLinkPosition()
  const generation = ++snapshotGeneration
  const identity = { generation, web, page, navigation }
  const canCapture = Boolean(
    web && handler && placed && page && loadedShown === page && positionedFrame &&
    snapshotBoundsAllowed(positionedFrame.width, positionedFrame.height) && releaseSnapshotImage,
  )
  if (!web || !handler) return
  if (!canCapture) {
    linkReviewBesideWeb = true
    handler(url, failedSnapshotPosition(pointer))
    return
  }
  void snapshotMailWebView(web).then((snapshot) => {
    // A navigation, hide, destroy, or newer click invalidates this exact page capture and URL.
    if (!snapshotIdentityMatches(identity, {
      generation: snapshotGeneration,
      web: view,
      page: shown,
      navigation: expectedNavigation,
      loadedPage: loadedShown,
      placed,
    })) return
    if (!snapshot) {
      linkReviewBesideWeb = true
      handler(url, failedSnapshotPosition(pointer))
      return
    }
    linkReviewBesideWeb = false
    setFrozenSnapshot(snapshot, page)
    // Paint the replacement image before opening the GPUI overlay and hiding WebKit.
    setTimeout(() => {
      if (!snapshotIdentityMatches(identity, {
        generation: snapshotGeneration,
        web: view,
        page: shown,
        navigation: expectedNavigation,
        loadedPage: loadedShown,
        placed,
      }) || frozenSnapshot !== snapshot) return
      handler(url, pointer ?? undefined)
    }, 34)
  })
}

function setClipperHidden(hidden: boolean) {
  if (!clipper) return
  clipperHidden = hidden
  msgBool(clipper, 'setHidden:', hidden)
  // Native smoke tests can't see AppKit views from the automation channel; they read this instead.
  if (process.env.JEFI_WEBVIEW_STATE_FILE) {
    appendFileSync(process.env.JEFI_WEBVIEW_STATE_FILE, `${JSON.stringify({ hidden, placed, loaded: loadedShown === shown, snapshot: currentMailSnapshot() !== null })}\n`)
  }
}

/** Applies mailViewHidden to the current state; every path that changes it ends here. */
function syncMailVisibility() {
  if (!clipper) return
  const covered = overlaysOpen() && !linkReviewBesideWeb
  // A page that loaded (or was placed, or re-laid out) while an overlay was already open never got
  // the on-screen capture. Try once per page while hidden, so the stand-in image can still appear.
  if (covered && placed && !currentMailSnapshot() && visibleCaptureGeneration !== snapshotGeneration &&
      loadedShown === shown && hiddenCaptureTried !== shown) {
    hiddenCaptureTried = shown
    beginOverlaySnapshot(false)
  }
  setClipperHidden(mailViewHidden({
    placed,
    overlays: overlaysOpen(),
    linkReviewBesideWeb,
    capturingOnScreen: visibleCaptureGeneration === snapshotGeneration,
  }))
}

/**
 * Freezes WebKit's pixels for the GPUI tree to paint while an overlay covers the reader. With
 * `onScreen`, the view stays visible until the image has painted, so there is no blank flash.
 */
function beginOverlaySnapshot(onScreen: boolean) {
  const web = view
  const page = shown
  const navigation = expectedNavigation
  const generation = ++snapshotGeneration
  const identity = { generation, web, page, navigation }
  if (!web || !placed || !page || loadedShown !== page || !positionedFrame || !releaseSnapshotImage ||
      !snapshotBoundsAllowed(positionedFrame.width, positionedFrame.height)) return
  if (onScreen) visibleCaptureGeneration = generation
  void snapshotMailWebView(web).then((snapshot) => {
    const current = snapshotIdentityMatches(identity, {
      generation: snapshotGeneration,
      web: view,
      page: shown,
      navigation: expectedNavigation,
      loadedPage: loadedShown,
      placed,
    })
    if (!snapshot || !overlaysOpen() || !current) {
      // Generic controls must remain reachable if WebKit cannot provide a stand-in: hide it anyway.
      // Link reviews use beginLinkReview instead, where a failed capture is placed beside WebKit.
      if (visibleCaptureGeneration === generation) visibleCaptureGeneration = -1
      syncMailVisibility()
      return
    }
    setFrozenSnapshot(snapshot, page)
    // The store notification removes the live-view gap before the native view steps aside.
    setTimeout(() => {
      if (visibleCaptureGeneration === generation) visibleCaptureGeneration = -1
      syncMailVisibility()
    }, 34)
  })
}

function hostWindowContent(): Pointer | null {
  const windows = msg(msg(cls('NSApplication'), 'sharedApplication'), 'windows')
  const count = msgInt(windows, 'count')
  for (let i = 0; i < count; i++) {
    const w = msgIndex(windows, 'objectAtIndex:', i)
    if (msgInt(w, 'isVisible')) return msg(w, 'contentView')
  }
  return null
}

export type NavigationPolicy = 'allow' | 'review' | 'cancel'

/**
 * What the message view does with a navigation. Only the message itself (loaded from a string, so
 * about:blank) loads in place, and a link to a spot in it (about:blank#section, a table of contents)
 * just scrolls: nothing is fetched and scripts are off. Any other link goes to the link review, and
 * everything else is cancelled.
 */
export function navigationPolicy(url: string, isLink: boolean): NavigationPolicy {
  if (url === 'about:blank') return 'allow'
  if (isLink && url.startsWith('about:blank#')) return 'allow'
  return isLink ? 'review' : 'cancel'
}

/** Corner radius of the mail page, natively and in the placeholder and snapshot under it. */
export const MAIL_CORNER_RADIUS = 12

function ensureView(): Pointer | null {
  if (view) return view
  const content = hostWindowContent()
  if (!content) return null
  loadWebKit()
  const config = msg(alloc('WKWebViewConfiguration'), 'init')
  msgBool(msg(config, 'defaultWebpagePreferences'), 'setAllowsContentJavaScript:', false)
  // Mail shouldn't leave cookies or caches behind.
  msg(config, 'setWebsiteDataStore:', msg(cls('WKWebsiteDataStore'), 'nonPersistentDataStore'))
  view = msgRectObj(alloc('WKWebView'), 'initWithFrame:configuration:', 0, 0, 10, 10, config)
  release(config)
  // The page is a card with rounded corners, like the placeholder drawn beneath it (html-view.tsx).
  msgBool(view, 'setWantsLayer:', true)
  const layer = msg(view, 'layer')
  if (layer) {
    msgDouble(layer, 'setCornerRadius:', MAIL_CORNER_RADIUS)
    msgBool(layer, 'setMasksToBounds:', true)
  }
  delegate = makeObject('JefiMailNavigationDelegate', 'WKNavigationDelegate', [
    {
      selector: 'webView:decidePolicyForNavigationAction:decisionHandler:',
      types: 'v@:@@@?',
      args: 3,
      fn: (_self, _cmd, _web, action, handler) => {
        let policy: NavigationPolicy = 'cancel'
        try {
          const url = fromNSString(msg(msg(msg(action, 'request'), 'URL'), 'absoluteString'))
          policy = navigationPolicy(url, msgInt(action, 'navigationType') === WK_NAVIGATION_LINK)
          if (policy === 'review') beginLinkReview(url)
        } catch {
          // The navigation is still cancelled below if WebKit supplied an unexpected action.
        } finally {
          callBlockWithInt(handler!, policy === 'allow' ? POLICY_ALLOW : POLICY_CANCEL)
        }
      },
    },
    {
      selector: 'webView:didFinishNavigation:',
      types: 'v@:@@',
      args: 2,
      fn: (_self, _cmd, _web, navigation) => {
        if (navigation !== expectedNavigation) return
        loadedShown = shown
        // Finished under an open overlay: take the stand-in snapshot now rather than never.
        syncMailVisibility()
      },
    },
  ])
  msg(view, 'setNavigationDelegate:', delegate)
  clipper = msgRectObj(alloc('NSView'), 'initWithFrame:', 0, 0, 10, 10, null)
  msgBool(clipper, 'setClipsToBounds:', true)
  msgBool(clipper, 'setWantsLayer:', true)
  const clipLayer = msg(clipper, 'layer')
  if (clipLayer) {
    msgDouble(clipLayer, 'setCornerRadius:', MAIL_CORNER_RADIUS)
    msgBool(clipLayer, 'setMasksToBounds:', true)
  }
  msg(clipper, 'addSubview:', view)
  msg(content, 'addSubview:', clipper)
  return view
}

/**
 * Shows `html` in the web view (loading only when it changed). Position it with `place`.
 * `allowRemoteImages` puts https: images in the policy; the page reloads when that changes, because
 * the policy is part of the page.
 */
export function showMail(html: string, allowRemoteImages = false, handleLink?: (url: string, position?: LinkPosition) => void) {
  onLink = handleLink ?? null
  const web = ensureView()
  if (!web) return false
  const page = mailPage(html, allowRemoteImages)
  if (page !== shown) {
    snapshotGeneration++
    discardFrozenSnapshot()
    loadedShown = ''
    shown = page
    expectedNavigation = msg(web, 'loadHTMLString:baseURL:', nsString(page), null)
    // The new page must not flash over an open overlay before the next place().
    syncMailVisibility()
  }
  return true
}

/**
 * Lays the web view over `frame`, visible only inside `clip`. Both are window coordinates with a
 * top-left origin (as GPUIX reports them); AppKit counts y from the bottom, hence the flips.
 */
/** The overlap of two frames; empty (zero-sized) where they don't meet. */
function intersect(a: Frame, b: Frame): Frame {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }
}

export function place(frame: Frame, clip: Frame, windowHeight: number) {
  if (!view || !clipper) return
  const geometry = JSON.stringify([frame, clip, windowHeight])
  const changed = positionedGeometry !== '' && geometry !== positionedGeometry
  positionedWindowHeight = windowHeight
  positionedFrame = frame
  positionedGeometry = geometry
  // The clipper is the part of the page that's in view, its corners rounded like the page's: where the
  // reader cuts the page off (under the reply box, above the window's top) the cut is rounded too.
  const visible = intersect(frame, clip)
  msgRect(clipper, 'setFrame:', visible.x, windowHeight - visible.y - visible.height, Math.max(visible.width, 1), Math.max(visible.height, 1))
  msgRect(view, 'setFrame:', frame.x - visible.x, visible.y + visible.height - frame.y - frame.height, Math.max(frame.width, 1), Math.max(frame.height, 1))
  placed = true
  if (changed) {
    // The frozen image no longer matches the layout; syncMailVisibility retakes it while hidden.
    snapshotGeneration++
    discardFrozenSnapshot()
    hiddenCaptureTried = ''
  }
  syncMailVisibility()
}

/** Current pixels, frozen before WebKit steps aside for a GPUIX overlay. */
const currentMailSnapshot = () => snapshotShown === shown && loadedShown === shown ? frozenSnapshot : null

/** Snapshot only when it belongs to these exact message bytes and image policy. */
export const mailSnapshot = (html: string, allowRemoteImages = false) =>
  snapshotShown === mailPage(html, allowRemoteImages) ? currentMailSnapshot() : null

// Menus and dialogs are drawn by GPUIX, underneath this view: freeze its current pixels, then step
// aside. The GPUI tree paints the frozen image at the same bounds until the overlay closes.
onOverlaysChange((anyOpen) => {
  if (anyOpen && placed && !clipperHidden && !linkReviewBesideWeb && !currentMailSnapshot()) beginOverlaySnapshot(true)
  if (!anyOpen) {
    snapshotGeneration++
    visibleCaptureGeneration = -1
    hiddenCaptureTried = ''
    linkReviewBesideWeb = false
    discardFrozenSnapshot()
  }
  syncMailVisibility()
})

export function hideMail() {
  snapshotGeneration++
  placed = false
  setClipperHidden(true)
}

/** Frees the web view and its web process: Full mode is off, or the reader closed. */
export function destroyMail() {
  snapshotGeneration++
  discardFrozenSnapshot()
  if (!view) return
  msg(clipper, 'removeFromSuperview')
  msg(view, 'setNavigationDelegate:', null)
  release(view)
  release(clipper)
  view = null
  clipper = null
  placed = false
  shown = ''
  loadedShown = ''
  expectedNavigation = null
  onLink = null
  positionedWindowHeight = 0
  positionedFrame = null
  positionedGeometry = ''
  clipperHidden = false
  visibleCaptureGeneration = -1
  hiddenCaptureTried = ''
  linkReviewBesideWeb = false
}

/** Open an already-reviewed web URL in the person's default browser. */
export function openExternalLink(raw: string) {
  if (!available) return false
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const nativeUrl = msg(cls('NSURL'), 'URLWithString:', nsString(url.href))
    if (!nativeUrl) return false
    return msgBoolResult(msg(cls('NSWorkspace'), 'sharedWorkspace'), 'openURL:', nativeUrl)
  } catch {
    return false
  }
}

/** Copy without visiting or otherwise resolving the destination. */
export function copyLink(raw: string) {
  if (!available) return false
  const pasteboard = msg(cls('NSPasteboard'), 'generalPasteboard')
  if (!pasteboard) return false
  msg(pasteboard, 'clearContents')
  msg(pasteboard, 'setString:forType:', nsString(raw), nsString('public.utf8-plain-text'))
  return true
}

/**
 * Where the message page may load images from. Images that travelled with the mail (data:, cid:)
 * always load; remote ones are opt-in and https: only, so an allowed sender still can't be read in
 * the clear by whoever the network belongs to.
 */
export const imageSources = (allowRemote: boolean) => (allowRemote ? 'data: cid: https:' : 'data: cid:')

/**
 * `<link>` elements that ask the network for something before anything is displayed. The policy
 * refuses the fetch, but a name lookup alone is enough for a tracker with a per-recipient
 * subdomain, so these are taken out of the message. `<a href>` is left alone: links must work.
 */
const SPECULATIVE_LINK = /<link\b[^>]*>/gi
const SPECULATIVE_REL = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

/** The message HTML without its speculative `<link>` elements. */
export function stripSpeculativeLinks(html: string): string {
  return html.replace(SPECULATIVE_LINK, (tag) => {
    const rel = tag.match(SPECULATIVE_REL)
    const tokens = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? '').toLowerCase().split(/\s+/)
    return tokens.some((token) => token === 'dns-prefetch' || token === 'preconnect' || token === 'prefetch' || token === 'preload' || token === 'prerender') ? '' : tag
  })
}

/** A doctype at the very start of the message (after whitespace and comments), which must stay first. */
const LEADING_DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i

/** The message page: its HTML under a policy that allows inline styles and images, nothing else. */
export function mailPage(html: string, allowRemoteImages: boolean) {
  const images = imageSources(allowRemoteImages)
  const policy = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src ${images}; media-src 'none'; form-action 'none'`
  // x-dns-prefetch-control stops WebKit resolving hostnames it finds in the message on its own.
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="color-scheme" content="light"><style>body{margin:16px;font:14px -apple-system,system-ui,sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}</style>`
  const body = stripSpeculativeLinks(html)
  // App-owned CSS discloses href text in the web view itself. Page JavaScript stays disabled, and
  // reading attr(href) cannot resolve, prefetch, or otherwise contact the destination.
  const linkDisclosure = `<style id="jefi-link-disclosure">a[href]:focus{outline:2px solid #3E63DD!important;outline-offset:2px!important}a[href]:hover::after,a[href]:focus::after{content:"Destination: " attr(href)!important;position:fixed!important;z-index:2147483647!important;left:12px!important;right:12px!important;bottom:12px!important;box-sizing:border-box!important;display:block!important;max-width:calc(100% - 24px)!important;padding:8px 10px!important;border:1px solid #555!important;border-radius:7px!important;background:#17171A!important;color:#FFF!important;font:12px -apple-system,system-ui,sans-serif!important;line-height:16px!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;pointer-events:none!important}</style>`
  // The policy goes first, ahead of everything the message has: a <meta> policy only counts in the
  // document's head and only for what comes after it. Slotting it into the message's own <head> let
  // mail with an <img> before that head, or a <header> element (which the lookup mistook for one),
  // load remote images unasked. After our head the parser still files the message's own <style>
  // and <meta> into the head and ignores its second <head>/<html> tags. A leading doctype is kept
  // first so the message renders in the mode it asked for.
  const doctype = body.match(LEADING_DOCTYPE)?.[0]
  const rest = doctype ? body.slice(doctype.length) : body
  const page = `${doctype?.trim() || '<!doctype html>'}<html><head>${head}</head>${rest}`
  // Last wins against an email's own a::after styles, including declarations marked important.
  return `${page}${linkDisclosure}`
}
