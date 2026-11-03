import { memo, useRef, useState } from 'react'
import { useSettings, type PaneWidths } from './theme'
import { geometryMayChange } from './geometry-wake'

// ---------------------------------------------------------------------------
// Draggable dividers between panes. Widths are kept in Settings, so they survive restarts.
// ---------------------------------------------------------------------------

export const PANE_LIMITS: Record<keyof PaneWidths, [number, number]> = {
  sidebar: [200, 360],
  list: [320, 640],
  assistant: [300, 560],
}

/** The width of a pane right now: the saved one, or the live one while it's being dragged. */
let live: Partial<PaneWidths> = {}
const listeners = new Set<() => void>()

export function usePaneWidth(pane: keyof PaneWidths) {
  const { settings } = useSettings()
  const [, bump] = useState(0)
  const subscribed = useRef(false)
  if (!subscribed.current) {
    subscribed.current = true
    listeners.add(() => bump((n) => n + 1))
  }
  return live[pane] ?? settings.paneWidths[pane]
}

/**
 * A thin grab strip on a pane's edge. `edge` says which side of the pane it sits on: dragging a
 * right-edge handle rightwards widens the pane; a left-edge handle (the assistant) is mirrored.
 */
/** Memoized: its props are constants, so the workspace's renders pass it by. */
export const PaneResizer = memo(PaneResizerView)

function PaneResizerView({ pane, edge = 'right' }: { pane: keyof PaneWidths; edge?: 'left' | 'right' }) {
  const { settings, update, C } = useSettings()
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null)
  const [hover, setHover] = useState(false)
  const hot = hover || !!drag
  const [min, max] = PANE_LIMITS[pane]
  const set = (width: number | undefined) => {
    live = { ...live, [pane]: width }
    listeners.forEach((l) => l())
    geometryMayChange()
  }
  const widthAt = (x: number) => Math.round(Math.min(max, Math.max(min, drag!.startWidth + (edge === 'right' ? x - drag!.startX : drag!.startX - x))))
  const finish = (x?: number) => {
    if (!drag) return
    const width = x === undefined ? (live[pane] ?? drag.startWidth) : widthAt(x)
    setDrag(null)
    update({ paneWidths: { ...settings.paneWidths, [pane]: width } })
    set(undefined)
  }
  return (
    <>
    <div style={{ width: 7, marginLeft: -4, marginRight: -3, height: '100%', flexShrink: 0, position: 'relative' }}>
      <div
        testId={`resize-${pane}`}
        onMouseDown={(event) => setDrag({ startX: event.x ?? 0, startWidth: live[pane] ?? settings.paneWidths[pane] })}
        // The first moves (and a quick release) can land here before the sheet below is mounted.
        onMouseMove={(event) => drag && event.pressedButton !== undefined && event.pressedButton !== null && set(widthAt(event.x ?? drag.startX))}
        onMouseUp={(event) => finish(event.x)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ position: 'absolute', top: 0, left: 0, width: 7, height: '100%', cursor: 'col-resize', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#00000001' }}
      >
        {/* Always a faint line with a grip, so the divider reads as draggable; accent while hovered or dragged. */}
        <div style={{ position: 'absolute', top: 0, left: hot ? 2 : 3, width: hot ? 3 : 1, height: '100%', backgroundColor: hot ? C.accent : C.divider, pointerEvents: 'none' }} />
        <div style={{ width: 5, height: 36, borderRadius: 3, backgroundColor: hot ? C.accent : C.border, pointerEvents: 'none' }} />
      </div>
    </div>
      {drag ? (
        // GPUIX has no pointer capture: while dragging, a sheet over the whole app (the root is the
        // positioned ancestor) takes every move and the release. It paints nothing.
        <div
          onMouseMove={(event) => (event.pressedButton === undefined || event.pressedButton === null ? finish(event.x) : set(widthAt(event.x ?? drag.startX)))}
          onMouseUp={(event) => finish(event.x)}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: '#00000001', cursor: 'col-resize' }}
        />
      ) : null}
    </>
  )
}
