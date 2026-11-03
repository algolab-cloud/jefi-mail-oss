import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A function with one identity for the component's life that always runs the latest render's `fn`,
 * so memoized children can take handlers without re-rendering and without seeing stale state.
 * Call it from events and effects, not during render.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
