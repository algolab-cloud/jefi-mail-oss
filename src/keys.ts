import { useEffect, useRef } from 'react'

// Window-level keyboard shortcuts. GPUIX reports every key press to render()'s onKeyDown; this
// fans it out to whichever components registered, newest first, until one handles it.

export type KeyPress = { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } }
/**
 * What the window is doing, for handlers that must not fire while someone is typing. Only the text
 * fields take keyboard focus (nothing else sets tabIndex), so a focused element means a field.
 */
export type KeyContext = { typing: boolean }
type Handler = (press: KeyPress, context: KeyContext) => boolean | void

const handlers: Handler[] = []

export function dispatchKey(press: KeyPress, context: KeyContext = { typing: false }) {
  for (const handler of [...handlers].reverse()) if (handler(press, context) === true) return
}

/** Registers `handler` while mounted; return true from it to stop older handlers seeing the key. */
export function useKeys(handler: Handler) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const entry: Handler = (press, context) => ref.current(press, context)
    handlers.push(entry)
    return () => void handlers.splice(handlers.indexOf(entry), 1)
  }, [])
}

export const isCmd = (press: KeyPress, key: string) => (press.modifiers?.cmd || press.modifiers?.ctrl) && press.key?.toLowerCase() === key
