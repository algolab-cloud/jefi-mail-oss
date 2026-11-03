import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Asking the workspace to show the tasks view, from anywhere (the reader's task chips, a toast
// action, the menu bar) without threading a callback through every pane. The workspace listens
// while mounted.
// ---------------------------------------------------------------------------

/** Show one task, or just the list. */
export type TaskRequest = { taskId: string } | { list: true }

const listeners = new Set<(request: TaskRequest) => void>()

/** Opens the tasks view on `taskId`. */
export const openTask = (taskId: string) => requestTasks({ taskId })

export function requestTasks(request: TaskRequest) {
  for (const listener of listeners) listener(request)
}

export function useTaskRequests(handler: (request: TaskRequest) => void) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const listener = (request: TaskRequest) => ref.current(request)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
}
