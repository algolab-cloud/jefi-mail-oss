import { createContext, useContext } from 'react'
import type { CalendarEvent, EventInput, Invite, Note } from '../engine'
import type { MailThread, Message } from '../data'
import type { ReactNode } from 'react'
import { InviteCard } from '../calendar/invite-card'
import { openNote as openNoteView } from '../notes/open'
import { openEventEditor as openCalendarEditor, showEvent } from '../calendar/state'
import { prefillFromInput } from '../calendar/draft'

// Where the reader hands off to views other beads build: the calendar (lume-fwl.3), notes
// (lume-fwl.4) and invites. Each is optional; without it the reader falls back to what it can do
// on its own (a toast, the quick-add form, a placeholder card). Wire them with
// <ReaderCalendarSeams.Provider value={...}> around the reader.

export type ReaderCalendarLinks = {
  /** Show this event in the calendar view (the calendar's showEvent by default). */
  openEvent?: (event: CalendarEvent) => void
  /** Open this note in the notes view (lume-fwl.4's openNote by default). */
  openNote?: (note: Note) => void
  /**
   * The full event editor, prefilled with what quick add has so far (it already carries the link
   * to the message). Quick add shows "More options…" only when this is set.
   * The calendar's openEventEditor by default.
   */
  openEventEditor?: (prefill: EventInput) => void
  /**
   * The invite card for a message with a calendar invite (lume-fwl.8's InviteCard by default).
   */
  renderInvite?: (props: { thread: Pick<MailThread, 'id' | 'subject'>; message: Message; invites: Invite[] }) => ReactNode
}

// The invite card and the notes view need nothing from the surrounding views, so they are wired by default.
const renderInvite: ReaderCalendarLinks['renderInvite'] = ({ thread, message }) => <InviteCard threadId={thread.id} messageId={message.id} />
const openNote: ReaderCalendarLinks['openNote'] = (note) => openNoteView(note.id)

// The calendar (lume-fwl.3) is wired by default too: its editor and navigation live in module state.
const openEvent: ReaderCalendarLinks['openEvent'] = (event) => showEvent(event)
const openEventEditor: ReaderCalendarLinks['openEventEditor'] = (input) => openCalendarEditor(prefillFromInput(input))

export const ReaderCalendarSeams = createContext<ReaderCalendarLinks>({ renderInvite, openNote, openEvent, openEventEditor })

export const useReaderSeams = () => useContext(ReaderCalendarSeams)
