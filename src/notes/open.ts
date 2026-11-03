import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Asking the workspace to show the notes view, from anywhere (the reader's linked notes, a toast
// action) without threading a callback through every pane. The workspace listens while mounted.
// ---------------------------------------------------------------------------

/** Show one note, or start a new one (prefilled by a jefi://new-note link). */
export type NoteRequest = { noteId: string } | { create: true; title?: string; body?: string }

const listeners = new Set<(request: NoteRequest) => void>()

/** Opens the notes view on `noteId`. */
export const openNote = (noteId: string) => requestNotes({ noteId })

export function requestNotes(request: NoteRequest) {
  for (const listener of listeners) listener(request)
}

export function useNoteRequests(handler: (request: NoteRequest) => void) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const listener = (request: NoteRequest) => ref.current(request)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
}
