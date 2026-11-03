import type { LinkTarget, Note, NoteInput, NoteLink } from '../engine'
import { appendBlock, emailTarget, quoteEmail, type EmailSource } from './model'

// ---------------------------------------------------------------------------
// "Add to notes" from the reader. The engine snapshots the linked mail (subject, sender, date) from
// its own database, so the caller passes ids only: link first, then write the title and quote from
// the snapshot the link came back with.
// ---------------------------------------------------------------------------

/** The store actions this needs (useMailActions() has them all). */
export type NoteWrites = {
  saveNote: (input: NoteInput) => Promise<Note | null>
  getNote: (id: string) => Promise<Note | null>
  linkNote: (noteId: string, target: LinkTarget) => Promise<NoteLink | null>
}

/**
 * Adds an email to a note: a new one (titled with the subject) when `noteId` is missing, else
 * appended to that note. The body gets the excerpt as a quote with its sender, and the note links
 * the message (or the conversation, without `messageId`). Resolves with the saved note, or null
 * after the store has toasted why it failed.
 */
export async function addEmailToNote(actions: NoteWrites, source: EmailSource, noteId?: string): Promise<Note | null> {
  const target = emailTarget(source)
  if (!noteId) {
    const created = await actions.saveNote({ title: '', body: '', links: [target] })
    if (!created) return null
    const snapshot = created.links[0]?.snapshot ?? {}
    return actions.saveNote({ id: created.id, title: snapshot.subject?.trim() || 'Email note', body: appendBlock('', quoteEmail(source.excerpt, snapshot)) })
  }
  const link = await actions.linkNote(noteId, target)
  if (!link) return null
  const note = await actions.getNote(noteId)
  if (!note) return null
  return actions.saveNote({ id: note.id, title: note.title, body: appendBlock(note.body, quoteEmail(source.excerpt, link.snapshot)) })
}
