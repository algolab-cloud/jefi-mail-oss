import { useEffect } from 'react'

// Popovers GPUIX draws can't appear above a native view (the Full HTML web view sits on top of the
// whole window). Menus and dialogs report here while open, and the web view steps aside meanwhile.

let open = 0
const listeners = new Set<(anyOpen: boolean) => void>()

export const overlaysOpen = () => open > 0
export function onOverlaysChange(listener: (anyOpen: boolean) => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Marks a popover as open for as long as `active` is true and the component is mounted. */
export function useOverlay(active: boolean) {
  useEffect(() => {
    if (!active) return
    open++
    if (open === 1) for (const listener of listeners) listener(true)
    return () => {
      open--
      if (open === 0) for (const listener of listeners) listener(false)
    }
  }, [active])
}
