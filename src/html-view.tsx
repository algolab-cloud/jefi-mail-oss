import { appendFileSync } from 'node:fs'
import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import { useGpuix, useWindowSize, type PublicInstance } from '@gpuix/react'
import { MAIL_CORNER_RADIUS, MIN_PAGE_HEIGHT, destroyMail, fullRenderingAvailable, hideMail, mailBackground, mailContentHeight, mailSnapshot, mailSnapshotRevision, maxPageHeight, place, setMailFits, setMailSnapshotImageReleaser, showMail, subscribeMailSnapshots, type MailTheme } from './native/mail-webview'
import type { LinkPosition } from './link-popover'
import { onGeometryMayChange } from './geometry-wake'

export { fullRenderingAvailable, type MailTheme }

// ---------------------------------------------------------------------------
// Remote images
// ---------------------------------------------------------------------------

/** An address the sender's server has to be asked for — including the protocol-relative `//host/x`. */
const REMOTE = /^\s*(?:https?:)?\/\//i

/** Attributes the renderer fetches an image for. `srcset` is read separately (it holds a list). */
const IMAGE_ATTRIBUTE = /\b(?:src|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const SRCSET_ATTRIBUTE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
/** `url(...)` in an inline style: background images load exactly like an `<img>`. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi

/** Every address the message would fetch an image from, in source order. */
function imageUrls(html: string): string[] {
  const value = (match: RegExpMatchArray) => match[1] ?? match[2] ?? match[3] ?? ''
  const urls: string[] = []
  for (const match of html.matchAll(IMAGE_ATTRIBUTE)) urls.push(value(match))
  for (const match of html.matchAll(SRCSET_ATTRIBUTE)) {
    // "a.png 1x, b.png 2x": each candidate is an address followed by its descriptor.
    for (const candidate of value(match).split(',')) urls.push(candidate.trim().split(/\s+/)[0] ?? '')
  }
  for (const match of html.matchAll(CSS_URL)) urls.push(value(match))
  return urls
}

/**
 * Whether the message asks for an image from somewhere on the network — the thing a sender uses to
 * learn that the mail was opened. Images carried inside the mail (data:, cid:) don't count.
 */
export const hasRemoteImages = (html: string) => imageUrls(html).some((url) => REMOTE.test(url))

/** The scrolling area the full view lives in: the web view is clipped to it. */
export const ClipContext = createContext<RefObject<PublicInstance | null> | null>(null)

/**
 * Something GPUIX draws floating over the reader (the unpinned assistant). The native web view sits
 * above everything GPUIX paints, so it has to be clipped out of the way instead.
 */
export const floatingObstacle: { current: PublicInstance | null } = { current: null }

const FAST_MS = 60
const IDLE_MS = 500
const SETTLE_MS = 2000
const HIDDEN = 'hidden'
/** Smoke tests read every placement poll from here (see scripts/testing/html-placement-idle.tsx). */
const placementLog = process.env.JEFI_PLACEMENT_LOG

type Box = { x: number; y: number; width: number; height: number }

/** The largest part of `clip` clear of `obstacle`: what's beside it or what's above/below it. */
export function clipAround(clip: Box, obstacle: Box | null): Box {
  if (!obstacle) return clip
  const right = clip.x + clip.width
  const bottom = clip.y + clip.height
  const overlaps = obstacle.x < right && obstacle.x + obstacle.width > clip.x && obstacle.y < bottom && obstacle.y + obstacle.height > clip.y
  if (!overlaps) return clip
  const candidates: Box[] = [
    { ...clip, width: obstacle.x - clip.x },
    { ...clip, x: obstacle.x + obstacle.width, width: right - obstacle.x - obstacle.width },
    { ...clip, height: obstacle.y - clip.y },
    { ...clip, y: obstacle.y + obstacle.height, height: bottom - obstacle.y - obstacle.height },
  ]
  const area = (b: Box) => Math.max(b.width, 0) * Math.max(b.height, 0)
  return candidates.reduce((best, b) => (area(b) > area(best) ? b : best))
}

/**
 * Full view of an HTML message: a placeholder in the layout with the system WebKit view laid
 * exactly over it. The native view isn't part of GPUIX's tree, so it follows the placeholder by
 * reading its bounds: often while the layout moves, rarely once it has settled.
 */
function useNativeMailView(html: string, allowRemoteImages: boolean, theme: MailTheme | undefined, onLink: (url: string) => void, sync: () => boolean) {
  const wakeRef = useRef<(() => void) | null>(null)
  // Any render may have moved the placeholder.
  useEffect(() => wakeRef.current?.())

  useEffect(() => {
    showMail(html, allowRemoteImages, onLink, theme)
    sync()
  }, [html, allowRemoteImages, theme, onLink, sync])

  // Geometry GPUIX doesn't announce (layout settling, animations) is still caught by polling, but
  // quickly only while something moves: after SETTLE_MS of unchanged placement it drops to IDLE_MS,
  // and scrolling, pane drags, renders or a window resize bring it straight back. Overlays don't
  // wait on this: mail-webview hides the view from onOverlaysChange the moment one opens.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stableSince = Date.now()
    let idle = false
    const tick = () => {
      const moved = sync()
      if (moved) stableSince = Date.now()
      if (placementLog) appendFileSync(placementLog, `${JSON.stringify({ t: Date.now(), moved })}\n`)
      idle = Date.now() - stableSince > SETTLE_MS
      timer = setTimeout(tick, idle ? IDLE_MS : FAST_MS)
    }
    const wake = () => {
      stableSince = Date.now()
      if (!idle) return
      clearTimeout(timer)
      tick()
    }
    wakeRef.current = wake
    timer = setTimeout(tick, FAST_MS)
    const unsubscribe = onGeometryMayChange(wake)
    return () => {
      clearTimeout(timer)
      unsubscribe()
      wakeRef.current = null
    }
  }, [sync])

  useEffect(() => () => destroyMail(), [])
}

export { maxPageHeight }

/**
 * The page's height: as tall as the message once WebKit has measured it, so the conversation is the one
 * thing that scrolls, with the page's rounded corners passing by at its ends. Only a message taller
 * than a frozen snapshot can cover (maxPageHeight) scrolls inside its page. `fallback` holds the place
 * until the message is measured, and stands in for good where the measuring helper isn't available.
 */
export function pageHeight(measured: number | null, fallback: number, width: number | null) {
  if (measured === null) return fallback
  return Math.min(Math.max(measured, MIN_PAGE_HEIGHT), width ? maxPageHeight(width) : 8000)
}

export function FullHtml({ html, height, allowRemoteImages = false, theme, onLink }: { html: string; height: number; allowRemoteImages?: boolean; theme?: MailTheme; onLink: (url: string, position: LinkPosition) => void }) {
  const ref = useRef<PublicInstance>(null)
  const renderer = useGpuix().renderer
  const releaseImageDataUrl = renderer?.releaseImageDataUrl
  setMailSnapshotImageReleaser(releaseImageDataUrl && renderer ? (source) => releaseImageDataUrl.call(renderer, source) : null)
  const { height: windowHeight } = useWindowSize()
  const clipRef = useContext(ClipContext)
  const last = useRef('')
  useSyncExternalStore(subscribeMailSnapshots, mailSnapshotRevision, mailSnapshotRevision)
  const snapshot = mailSnapshot(html, allowRemoteImages, theme)
  const width = ref.current ? renderer?.getElementBounds?.(ref.current.id)?.width ?? null : null
  const measured = mailContentHeight(html, allowRemoteImages, theme)
  const shownHeight = pageHeight(measured, height, width)
  // Whole message shown: scrolling over it moves the conversation. Otherwise the page scrolls too.
  const fits = measured !== null && measured <= shownHeight
  useEffect(() => setMailFits(fits), [fits, html])

  // Whether placement changed, which is what the poll's back-off counts.
  const hide = () => {
    hideMail()
    if (last.current === HIDDEN) return false
    last.current = HIDDEN
    return true
  }
  const boundsOf = useCallback((instance: PublicInstance | null | undefined) => (instance ? renderer?.getElementBounds?.(instance.id) ?? null : null), [renderer])
  const sync = useCallback(() => {
    const bounds = boundsOf(ref.current)
    const area = boundsOf(clipRef?.current) ?? bounds
    if (!bounds || !area || bounds.width < 2 || bounds.height < 2) return hide()
    const clip = clipAround(area, boundsOf(floatingObstacle.current))
    if (clip.width < 2 || clip.height < 2) return hide()
    const key = JSON.stringify([bounds, clip, windowHeight])
    if (key === last.current) return false
    last.current = key
    place(bounds, clip, windowHeight)
    return true
  }, [boundsOf, windowHeight])
  const reviewLink = useCallback((url: string, eventPosition?: LinkPosition) => {
    const bounds = boundsOf(ref.current)
    const position = eventPosition ?? (bounds
      ? { x: bounds.x + Math.min(bounds.width - 28, Math.max(28, bounds.width * 0.5)), y: bounds.y + Math.min(bounds.height - 28, Math.max(28, bounds.height * 0.35)) }
      : { x: 220, y: 160 })
    onLink(url, position)
  }, [boundsOf, onLink])

  useNativeMailView(html, allowRemoteImages, theme, reviewLink, sync)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      <div ref={ref} testId="html-full" style={{ height: shownHeight, borderRadius: MAIL_CORNER_RADIUS, backgroundColor: mailBackground(html, theme), flexShrink: 0, overflow: 'hidden' }}>
        {snapshot ? (
          <img testId="html-overlay-snapshot" src={snapshot} objectFit="fill" style={{ width: '100%', height: '100%', pointerEvents: 'none' }} />
        ) : null}
      </div>
    </div>
  )
}
