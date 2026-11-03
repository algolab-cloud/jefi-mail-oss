import { useEffect, useRef } from 'react'

// Requests from outside the workspace (the menu bar panel) for things only the workspace can open:
// a new message and Settings. Same shape as requestNotes / requestCalendar.

export type WorkspaceRequest = 'compose' | 'settings'

const listeners = new Set<(request: WorkspaceRequest) => void>()

export function requestWorkspace(request: WorkspaceRequest) {
  for (const listener of listeners) listener(request)
}

export function useWorkspaceRequests(handler: (request: WorkspaceRequest) => void) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const listener = (request: WorkspaceRequest) => ref.current(request)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
}
