import { useEffect, useRef, useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Debounced autosave for the note editor: every edit restarts the timer, one save runs when typing
// pauses, and an edit made while a save is in flight is saved right after it (never two at once).
// Framework-free so the timing is tested with plain timers; useAutosave wraps it for React.
// ---------------------------------------------------------------------------

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed'

export type Autosaver<T> = {
  /** Remember `value` and save it once edits pause for `delay` ms. */
  schedule: (value: T) => void
  /** Save what's waiting now (switching notes, closing the view). */
  flush: () => Promise<void>
  state: () => SaveState
  subscribe: (listener: () => void) => () => void
  /** Stop the timer without saving. */
  cancel: () => void
}

export function createAutosaver<T>({ delay, save }: { delay: number; save: (value: T) => Promise<unknown> }): Autosaver<T> {
  let state: SaveState = 'idle'
  let waiting: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const set = (next: SaveState) => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  const run = async (): Promise<void> => {
    if (running) return running
    if (!waiting) return
    const { value } = waiting
    waiting = null
    set('saving')
    running = (async () => {
      let ok = true
      try {
        // The store's actions resolve null after toasting a failure rather than throwing.
        ok = (await save(value)) !== null
      } catch {
        ok = false
      }
      running = null
      if (waiting) return run()
      set(ok ? 'saved' : 'failed')
    })()
    return running
  }

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    schedule(value) {
      waiting = { value }
      clear()
      if (!running) set('pending')
      timer = setTimeout(() => {
        timer = null
        void run()
      }, delay)
    },
    async flush() {
      clear()
      await run()
      if (running) await running
    },
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    cancel() {
      clear()
      waiting = null
    },
  }
}

/**
 * An autosaver for the component's lifetime. Unmounting saves what's waiting, unless `onUnmount`
 * takes over (the editor drops a note left blank instead of saving it).
 */
export function useAutosave<T>(
  save: (value: T) => Promise<unknown>,
  { delay = 600, onUnmount }: { delay?: number; onUnmount?: (saver: Autosaver<T>) => void } = {},
): { schedule: (value: T) => void; flush: () => Promise<void>; cancel: () => void; state: SaveState } {
  const saveRef = useRef(save)
  saveRef.current = save
  const unmountRef = useRef(onUnmount)
  unmountRef.current = onUnmount
  const ref = useRef<Autosaver<T> | null>(null)
  if (!ref.current) ref.current = createAutosaver<T>({ delay, save: (value) => saveRef.current(value) })
  const saver = ref.current
  useEffect(
    () => () => {
      if (unmountRef.current) unmountRef.current(saver)
      else void saver.flush()
    },
    [saver],
  )
  const state = useSyncExternalStore(saver.subscribe, saver.state)
  return { schedule: saver.schedule, flush: saver.flush, cancel: saver.cancel, state }
}
