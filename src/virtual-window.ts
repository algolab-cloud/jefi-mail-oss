import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// A window of rows for a `<virtual-list>`: native lays out and paints only the rows near its
// viewport, and React mounts only the slice it reports (plus some overdraw), so a list of thousands
// costs about what a screenful does, both to mount and on every frame after. The mail list does the
// same by hand (list.tsx); this is that logic for the tasks and notes lists.
// ---------------------------------------------------------------------------

/** Rows mounted from the top before the list first reports what it shows, and around it after. */
export const WINDOW = 40
export const OVERDRAW = 12

export type RowWindow = { start: number; end: number }

/** The rows to mount for a reported visible range: never narrower than a screenful. */
export function windowFor(range: { startIndex?: number; endIndex?: number }): RowWindow {
  const start = Math.max(0, (range.startIndex ?? 0) - OVERDRAW)
  // Not clamped to today's length: a range reported while the list was short must still show rows
  // that arrive afterwards.
  return { start, end: Math.max(start + WINDOW, (range.endIndex ?? 0) + OVERDRAW) }
}

/**
 * The window for a list of `count` rows. `resetKey` names the list: when it changes (another view,
 * grouping or search) the list starts over at the top, remounted through `generation` since the
 * native scroll offset belongs to the old rows. So does a list that shrank out from under a window
 * scrolled down it.
 */
export function useRowWindow(count: number, resetKey: string) {
  const [window, setWindow] = useState<RowWindow>({ start: 0, end: WINDOW })
  const [generation, setGeneration] = useState(0)
  const last = useRef({ key: resetKey, count })
  if (last.current.key !== resetKey) {
    last.current = { key: resetKey, count }
    setWindow({ start: 0, end: WINDOW })
    setGeneration((g) => g + 1)
  } else if (last.current.count !== count) {
    const shrank = count < last.current.count
    last.current = { key: resetKey, count }
    if (shrank && window.start > 0 && window.start + OVERDRAW >= count) {
      setWindow({ start: 0, end: WINDOW })
      setGeneration((g) => g + 1)
    }
  }
  const onVisibleRange = (event: { startIndex?: number; endIndex?: number }) => {
    const next = windowFor(event)
    if (next.start !== window.start || next.end !== window.end) setWindow(next)
  }
  return { start: window.start, end: window.end, generation, onVisibleRange }
}

/**
 * Keeps row `index` of a `<virtual-list>` in view when it changes (J/K moving the highlight): at the
 * top when it's above the viewport, at the bottom when below. `heights` are the rows' laid-out
 * heights, for working out where the row sits.
 */
export function useRevealRow(list: React.RefObject<PublicInstance | null>, index: number, heightOf: (index: number) => number) {
  const renderer = useGpuix()?.renderer
  useEffect(() => {
    const id = list.current?.id
    if (index < 0 || id == null || !renderer?.scrollToItem || !renderer.getListScrollTop) return
    const anchor = renderer.getListScrollTop(id)
    if (!anchor || anchor.length < 3) return
    const [top, offset, viewport] = anchor as [number, number, number]
    const where = rowPlacement(heightOf, index, { index: top, offset, viewport })
    if (where === 'above') renderer.scrollToItem(id, index, 0)
    else if (where === 'below') renderer.scrollToItem(id, index, -(viewport - heightOf(index) - 4))
  }, [index])
}

/** Where row `index` sits against a viewport scrolled to row `top.index`, `top.offset` px into it. */
export function rowPlacement(heightOf: (index: number) => number, index: number, top: { index: number; offset: number; viewport: number }): 'visible' | 'above' | 'below' {
  if (index < top.index) return 'above'
  let y = -top.offset
  for (let i = top.index; i < index; i++) y += heightOf(i)
  if (y < 0) return 'above'
  return y + heightOf(index) > top.viewport ? 'below' : 'visible'
}
