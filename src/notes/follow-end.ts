import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useRef, type RefObject } from 'react'

// ---------------------------------------------------------------------------
// Long text fields (a note's body, a task's notes) grow with their text inside a page that scrolls,
// rather than scrolling within a few rows of their own (which opened a long note at its last
// lines). The page doesn't follow the caret, so typing at the very end scrolls it to the end.
// ---------------------------------------------------------------------------

/** Text added at the end, the usual way a long note grows. */
export const appendedAtEnd = (before: string, after: string) => after.length > before.length && after.startsWith(before)

/** What the page looked like after the last follow: the field's height and where the page sat. */
export type FollowMark = { height: number; offset: number | undefined }

/**
 * Whether typing at the end has to scroll the page: not when the field is as tall as it was and the
 * page is still where the last follow left it (already at the end). Scrolling redraws the window, so
 * doing it for every keystroke on the same line cost a frame each.
 */
export const needsFollow = (last: FollowMark | null, height: number | undefined, offset: number | undefined) =>
  !last || height === undefined || offset === undefined || last.offset === undefined || height !== last.height || offset !== last.offset

type Box = { y: number; height: number }
/**
 * Whether the field's last line is already inside the page: then there's nothing to follow. (Asking
 * for the end anyway nudged a short page by its padding, which the scroll range counts, hiding the
 * title under the header.)
 */
export const endInView = (page: Box | null | undefined, field: Box | null | undefined) =>
  !!page && !!field && field.y + field.height <= page.y + page.height

/** A few frames (they run every 8 ms): long enough for an edit, or a scroll, to have been laid out. */
const SETTLE_MS = 24

/**
 * Refs for the scrolling page and the field in it, and `follow(before, after)` to call with each edit
 * of the field (or pass the field's own ref). Without one on the field it scrolls on every edit at
 * the end.
 */
export function useFollowEnd(fieldRef?: RefObject<PublicInstance | null>) {
  const page = useRef<PublicInstance | null>(null)
  const own = useRef<PublicInstance | null>(null)
  const field = fieldRef ?? own
  const last = useRef<FollowMark | null>(null)
  const renderer = useGpuix()?.renderer
  const follow = (before: string, after: string) => {
    if (!appendedAtEnd(before, after)) return
    // After the frame that lays out the new text (frames run every 8 ms), so the field's height is
    // this edit's; the offset is clamped to the end.
    setTimeout(() => {
      const id = page.current?.id
      if (id == null || !renderer?.scrollTo) return
      const fieldId = field.current?.id
      const box = fieldId == null ? undefined : renderer.getElementBounds?.(fieldId)
      if (endInView(renderer.getElementBounds?.(id), box)) return
      const height = box?.height
      const offset = renderer.getScrollOffset?.(id)?.[1]
      if (!needsFollow(last.current, height, offset)) return
      renderer.scrollTo(id, 0, -1e7)
      const mark: FollowMark = { height: height ?? -1, offset: undefined }
      last.current = mark
      // Where the page settled, once the scroll has been laid out.
      setTimeout(() => {
        if (last.current === mark) mark.offset = renderer.getScrollOffset?.(id)?.[1]
      }, SETTLE_MS)
    }, SETTLE_MS)
  }
  return { page, field, follow }
}
