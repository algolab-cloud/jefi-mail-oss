import type { MailDatabase } from '../db'
import { THREAD_MATCH, linkOf, mailLinkColumns, threadMatchArgs, type LinkRow } from './links'
import { newId } from './store'
import type { LinkSnapshot, LinkTarget, Note, NoteInput, NoteLink } from './types'

// ---------------------------------------------------------------------------
// Notes: local markdown, belonging to no account, searchable (note_search, FTS5), linked to mail,
// events and people. Listing returns notes with their links; bodies are small enough to send whole.
// ---------------------------------------------------------------------------

type NoteRow = { n: number; id: string; title: string; body: string; pinned: number; created_at: number; updated_at: number }

const LINK_COLUMNS = 'l.id, l.note_id, l.kind, l.account_id, l.target_ref, l.message_id_header, l.snapshot_json, l.created_at'

function linksOf(db: MailDatabase, noteIds: string[]): Map<string, NoteLink[]> {
  const out = new Map<string, NoteLink[]>()
  if (!noteIds.length) return out
  const rows = db.query(`SELECT ${LINK_COLUMNS} FROM note_links l WHERE l.note_id IN (SELECT value FROM json_each(?)) ORDER BY l.created_at, l.rowid`).all(JSON.stringify(noteIds)) as Array<
    LinkRow & { note_id: string }
  >
  for (const row of rows) out.set(row.note_id, [...(out.get(row.note_id) ?? []), { ...linkOf(db, row), noteId: row.note_id }])
  return out
}

function notesOf(db: MailDatabase, rows: NoteRow[]): Note[] {
  const links = linksOf(db, rows.map((r) => r.id))
  return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, pinned: r.pinned === 1, createdAt: r.created_at, updatedAt: r.updated_at, links: links.get(r.id) ?? [] }))
}

/** Each word as a quoted prefix term, so any input is a valid query and "meet" finds "meeting". */
const matchQuery = (query: string) =>
  query
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ''))
    .filter(Boolean)
    .map((word) => `"${word}"*`)
    .join(' ')

/** Pinned first, then most recently edited; `query` searches titles and bodies (best matches first). */
export function listNotes(db: MailDatabase, query?: string): Note[] {
  const match = query ? matchQuery(query) : ''
  const rows = match
    ? (db.query('SELECT n.* FROM note_search s JOIN notes n ON n.n = s.rowid WHERE note_search MATCH ? ORDER BY n.pinned DESC, bm25(note_search), n.updated_at DESC').all(match) as NoteRow[])
    : (db.query('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC, n DESC').all() as NoteRow[])
  return notesOf(db, rows)
}

export function getNote(db: MailDatabase, id: string): Note | null {
  const row = db.query('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | null
  return row ? notesOf(db, [row])[0]! : null
}

/** Creates or updates a note; `links` are added (existing links stay; unlinkNote removes one). */
export function saveNote(db: MailDatabase, input: NoteInput): Note {
  const id = db.transaction(() => {
    const at = Date.now()
    const existing = input.id ? (db.query('SELECT * FROM notes WHERE id = ?').get(input.id) as NoteRow | null) : null
    if (input.id && !existing) throw new Error('Note not found')
    const id = existing?.id ?? newId('note')
    if (existing) db.run('UPDATE notes SET title = ?, body = ?, pinned = ?, updated_at = ? WHERE id = ?', [input.title, input.body, (input.pinned ?? existing.pinned === 1) ? 1 : 0, at, id])
    else db.run('INSERT INTO notes (id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, input.title, input.body, input.pinned ? 1 : 0, at, at])
    for (const target of input.links ?? []) linkNote(db, id, target)
    return id
  })()
  return getNote(db, id)!
}

export function deleteNote(db: MailDatabase, id: string): boolean {
  return db.transaction(() => {
    db.run('DELETE FROM note_links WHERE note_id = ?', [id])
    return db.run('DELETE FROM notes WHERE id = ?', [id]).changes > 0
  })()
}

/**
 * Links a note to mail, an event or a person, snapshotting the target as it is now. Linking the
 * same target again refreshes its snapshot instead of adding a second link.
 */
export function linkNote(db: MailDatabase, noteId: string, target: LinkTarget, snapshot: LinkSnapshot = {}): NoteLink {
  if (!db.query('SELECT 1 FROM notes WHERE id = ?').get(noteId)) throw new Error('Note not found')
  let columns: { accountId: string | null; ref: string; header: string | null; snapshot: LinkSnapshot }
  if (target.kind === 'event') {
    const event = db.query('SELECT title, start_at FROM events WHERE id = ?').get(target.eventId) as { title: string; start_at: number } | null
    if (!event) throw new Error('Event not found')
    columns = { accountId: null, ref: target.eventId, header: null, snapshot: { ...snapshot, title: event.title, date: event.start_at } }
  } else if (target.kind === 'contact') {
    const email = target.email.trim().toLowerCase()
    if (!email) throw new Error('A contact link needs an email address')
    columns = { accountId: null, ref: email, header: null, snapshot: { ...snapshot, email, ...(target.name ? { name: target.name } : {}) } }
  } else columns = mailLinkColumns(db, target, snapshot)
  const same = db.query('SELECT id FROM note_links WHERE note_id = ? AND kind = ? AND account_id IS ? AND target_ref = ?').get(noteId, target.kind, columns.accountId, columns.ref) as { id: string } | null
  const id = same?.id ?? newId('nlink')
  db.transaction(() => {
    if (same) db.run('UPDATE note_links SET message_id_header = ?, snapshot_json = ? WHERE id = ?', [columns.header, JSON.stringify(columns.snapshot), id])
    else {
      db.run('INSERT INTO note_links (id, note_id, kind, account_id, target_ref, message_id_header, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        id, noteId, target.kind, columns.accountId, columns.ref, columns.header, JSON.stringify(columns.snapshot), Date.now(),
      ])
    }
    // A link is an edit: the note moves up the list.
    db.run('UPDATE notes SET updated_at = ? WHERE id = ?', [Date.now(), noteId])
  })()
  return linksOf(db, [noteId]).get(noteId)!.find((l) => l.id === id)!
}

export function unlinkNote(db: MailDatabase, linkId: string): boolean {
  return db.run('DELETE FROM note_links WHERE id = ?', [linkId]).changes > 0
}

const notesWhere = (db: MailDatabase, where: string, args: Array<string | number>) =>
  notesOf(db, db.query(`SELECT DISTINCT n.* FROM note_links l JOIN notes n ON n.id = l.note_id WHERE ${where} ORDER BY n.pinned DESC, n.updated_at DESC, n.n DESC`).all(...args) as NoteRow[])

/** Notes linked to a conversation or any of its messages. */
export const notesForThread = (db: MailDatabase, accountId: string, threadId: string): Note[] => notesWhere(db, THREAD_MATCH, [...threadMatchArgs(db, accountId, threadId)])

export const notesForEvent = (db: MailDatabase, eventId: string): Note[] => notesWhere(db, "l.kind = 'event' AND l.target_ref = ?", [eventId])
