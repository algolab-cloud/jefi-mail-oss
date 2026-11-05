import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { FONT, useSettings } from './theme'

// ---------------------------------------------------------------------------
// Tooltip: a small label that appears beside whatever it wraps while the pointer rests on it.
// Works for anything: icon buttons, menu items, chart bars.
// ---------------------------------------------------------------------------

type Side = 'top' | 'bottom' | 'left' | 'right'

/** Height a tooltip needs above its target (two lines plus the gap); with less, it opens below. */
const ROOM_ABOVE = 48

/**
 * Where the tooltip opens: below instead of above a target near the window's top edge (the reader's
 * toolbar). Left to GPUIX, it was pushed into the window on top of its own target, took the pointer
 * from it, closed, and opened again: a flicker for as long as the pointer stayed.
 */
export const tooltipSide = (side: Side, targetTop: number | null) => (side === 'top' && targetTop !== null && targetTop < ROOM_ABOVE ? 'bottom' : side)

export function Tooltip({
  label,
  detail,
  lines,
  children,
  side = 'top',
  delay = 450,
  grow,
  testId,
  hovered,
}: {
  /** The main line; nothing is shown when it's empty. */
  label: string | null | undefined
  /** An optional second, quieter line (e.g. a count under a date). */
  detail?: string
  /** Further quiet lines under the detail, for a small popover of facts. */
  lines?: string[]
  children: ReactNode
  side?: Side
  /** Milliseconds before it appears. Charts want 0; buttons a short pause so passing over doesn't flash. */
  delay?: number
  /** Let the wrapper stretch like the child would (for flex children such as chart columns). */
  grow?: boolean
  testId?: string
  /**
   * Hover as tracked by the parent. GPUIX sends enter/leave only to the element under the pointer,
   * so when the child has its own hover handlers the wrapper never hears them; pass them in here.
   */
  hovered?: boolean
}) {
  const { C } = useSettings()
  const renderer = useGpuix().renderer
  const ref = useRef<PublicInstance>(null)
  const [open, setOpen] = useState(false)
  const [shownSide, setShownSide] = useState<Side>(side)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])
  useEffect(() => {
    if (hovered === undefined) return
    if (hovered) enter()
    else leave()
  }, [hovered])
  const enter = () => {
    clear()
    const bounds = ref.current ? renderer?.getElementBounds?.(ref.current.id) : null
    setShownSide(tooltipSide(side, bounds ? bounds.y : null))
    if (delay <= 0) setOpen(true)
    else timer.current = setTimeout(() => setOpen(true), delay)
  }
  const leave = () => {
    clear()
    setOpen(false)
  }
  return (
    <div
      ref={ref}
      onMouseEnter={hovered === undefined ? enter : undefined}
      onMouseLeave={hovered === undefined ? leave : undefined}
      onMouseDown={leave}
      style={grow ? { flexGrow: 1, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'column' } : { display: 'flex', flexShrink: 0 }}
    >
      {children}
      {open && label ? (
        // Never a hit target itself, so even a tooltip pushed over its target can't take the pointer from it.
        <anchored side={shownSide} align="center" gap={6} fit="snap" deferred priority={3} style={{ backgroundColor: C.raised, borderRadius: 8, pointerEvents: 'none' }}>
          <div
            testId={testId}
            style={{
              paddingLeft: 8,
              paddingRight: 8,
              paddingTop: 5,
              paddingBottom: 5,
              borderRadius: 8,
              backgroundColor: C.raised,
              borderWidth: 1,
              borderColor: C.overlayStrong,
              boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 12, spreadRadius: 0, color: '#00000044' },
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              pointerEvents: 'none',
            }}
          >
            <text style={{ fontSize: 12, fontWeight: 500, color: C.text, fontFamily: FONT, whiteSpace: 'nowrap' }}>{label}</text>
            {[detail, ...(lines ?? [])].filter(Boolean).map((line, i) => (
              <text key={i} style={{ fontSize: 11.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap' }}>{line!}</text>
            ))}
          </div>
        </anchored>
      ) : null}
    </div>
  )
}
