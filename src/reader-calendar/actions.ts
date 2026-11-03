// The writes behind the reader's "Add to calendar" and "Add to notes", over the few store actions
// they need (useMailActions() in the app, the engine's own functions in tests).

import type { MailThread, Message } from '../data'
import type { CalendarEvent, EventInput, EventLink, MailLinkTarget, Note, NoteInput, NoteLink, LinkTarget } from '../engine'
import { appendToBody, eventFromDraft, newNoteFromMessage, type QuickAddDraft } from './suggest'

export type ReaderApi = {
  saveEvent: (input: EventInput) => Promise<CalendarEvent | null>
  eventLinks: (eventId: string) => Promise<EventLink[]>
  saveNote: (input: NoteInput) => Promise<Note | null>
  getNote: (id: string) => Promise<Note | null>
  linkNote: (noteId: string, target: LinkTarget) => Promise<NoteLink | null>
  threadTarget: (threadId: string) => MailLinkTarget
  messageTarget: (threadId: string, messageId: string) => MailLinkTarget
}

/** Saves the quick-add form as an event linked to the message; the error to show when it can't. */
export async function quickAddEvent(api: Pick<ReaderApi, 'saveEvent' | 'messageTarget'>, draft: QuickAddDraft, threadId: string, messageId: string, timeZone?: string): Promise<{ ok: true; event: CalendarEvent } | { ok: false; error: string }> {
  const built = eventFromDraft(draft, api.messageTarget(threadId, messageId), timeZone)
  if (!built.ok) return built
  const event = await api.saveEvent(built.input)
  // The store already toasted what went wrong.
  return event ? { ok: true, event } : { ok: false, error: 'The event wasn’t saved' }
}

/**
 * A new note titled from the subject, with the message's opening lines quoted, linked to the
 * conversation (so it shows beside it) and the message itself (so it opens the exact email).
 */
export function addToNewNote(api: Pick<ReaderApi, 'saveNote' | 'threadTarget' | 'messageTarget'>, thread: Pick<MailThread, 'id' | 'subject'>, message: Message) {
  return api.saveNote({ ...newNoteFromMessage(thread, message), links: [api.threadTarget(thread.id), api.messageTarget(thread.id, message.id)] })
}

/** Adds the excerpt to the end of an existing note and links it to the conversation and message. */
export async function appendToNote(api: Pick<ReaderApi, 'saveNote' | 'getNote' | 'threadTarget' | 'messageTarget'>, noteId: string, thread: Pick<MailThread, 'id' | 'subject'>, message: Message) {
  const note = await api.getNote(noteId)
  if (!note) return null
  return api.saveNote({
    id: note.id,
    title: note.title,
    body: appendToBody(note.body, thread, message),
    links: [api.threadTarget(thread.id), api.messageTarget(thread.id, message.id)],
  })
}

/** A conversation's events with their links, so each message can tell which were made from it. */
export async function threadEventsWithLinks(events: CalendarEvent[], eventLinks: ReaderApi['eventLinks']) {
  return Promise.all(events.map(async (event) => ({ event, links: await eventLinks(event.id) })))
}
