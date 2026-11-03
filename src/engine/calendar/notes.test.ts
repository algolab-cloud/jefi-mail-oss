import { afterEach, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from '../db'
import { ensureAccount } from '../mail-store'
import { deleteNote, getNote, linkNote, listNotes, notesForEvent, notesForThread, saveNote, unlinkNote } from './notes'
import { deleteEvent, saveEvent } from './store'

const dbs: MailDatabase[] = []
afterEach(() => {
  while (dbs.length) dbs.pop()!.close()
})
const fresh = () => {
  const db = openDatabase(':memory:')
  dbs.push(db)
  return db
}

function mail(db: MailDatabase, accountId: string, n: number, thread: string | null = 't1') {
  ensureAccount(db, accountId, `${accountId}@example.com`)
  db.run("INSERT INTO messages (account_id, message_id, thread_id, subject, from_email, date) VALUES (?, ?, ?, ?, 'ada@example.com', ?)", [accountId, `<n${n}@example.com>`, thread, `Subject ${n}`, n])
  return (db.query('SELECT last_insert_rowid() id').get() as { id: number }).id
}

test('notes: create, edit, pin and delete; pinned first, then latest edited', async () => {
  const db = fresh()
  const a = saveNote(db, { title: 'Groceries', body: '- milk\n- eggs' })
  expect(a).toMatchObject({ title: 'Groceries', body: '- milk\n- eggs', pinned: false, links: [] })
  await Bun.sleep(2)
  const b = saveNote(db, { title: 'Ideas', body: 'A calendar that reads mail' })
  expect(listNotes(db).map((n) => n.title)).toEqual(['Ideas', 'Groceries'])
  saveNote(db, { id: a.id, title: 'Groceries', body: '- milk', pinned: true })
  expect(listNotes(db).map((n) => [n.title, n.pinned])).toEqual([['Groceries', true], ['Ideas', false]])
  // Leaving `pinned` out keeps it.
  expect(saveNote(db, { id: a.id, title: 'Shopping', body: '- milk' }).pinned).toBe(true)
  expect(() => saveNote(db, { id: 'nope', title: '', body: '' })).toThrow('Note not found')
  expect(deleteNote(db, b.id)).toBe(true)
  expect(deleteNote(db, b.id)).toBe(false)
  expect(getNote(db, b.id)).toBeNull()
  expect(listNotes(db).map((n) => n.title)).toEqual(['Shopping'])
})

test('notes search: titles and bodies, by word prefix, any input safe', () => {
  const db = fresh()
  saveNote(db, { title: 'Meeting notes', body: 'Budget for Q3' })
  saveNote(db, { title: 'Recipe', body: 'Crème brûlée' })
  const titles = (q: string) => listNotes(db, q).map((n) => n.title)
  expect(titles('meet')).toEqual(['Meeting notes'])
  expect(titles('budget q3')).toEqual(['Meeting notes'])
  expect(titles('creme')).toEqual(['Recipe'])
  expect(titles('"unbalanced AND (')).toEqual([])
  expect(titles('   ')).toEqual(['Recipe', 'Meeting notes'])
  // Edits and deletes reach the index.
  const recipe = listNotes(db, 'recipe')[0]!
  saveNote(db, { id: recipe.id, title: 'Dessert', body: 'Tarte tatin' })
  expect(titles('brulee')).toEqual([])
  expect(titles('tatin')).toEqual(['Dessert'])
  deleteNote(db, recipe.id)
  expect(titles('tatin')).toEqual([])
})

test('note links: threads, messages, events and people, each with a snapshot', () => {
  const db = fresh()
  const first = mail(db, 'a', 1)
  mail(db, 'a', 2)
  const event = saveEvent(db, { title: 'Dentist', startAt: 1_000, endAt: 2_000 })
  const note = saveNote(db, {
    title: 'Follow-ups',
    body: '',
    links: [
      { kind: 'thread', accountId: 'a', threadId: 'a:t1' },
      { kind: 'event', eventId: event.id },
      { kind: 'contact', email: ' Ada@Example.com ', name: 'Ada' },
    ],
  })
  expect(note.links.map((l) => [l.target, l.snapshot, l.live])).toEqual([
    [{ kind: 'thread', accountId: 'a', threadId: 'a:t1' }, { subject: 'Subject 1', from: { email: 'ada@example.com' }, date: 2 }, true],
    [{ kind: 'event', eventId: event.id }, { title: 'Dentist', date: 1_000 }, true],
    [{ kind: 'contact', email: 'ada@example.com', name: 'Ada' }, { email: 'ada@example.com', name: 'Ada' }, true],
  ])
  // Linking the same thread again refreshes it rather than adding one.
  linkNote(db, note.id, { kind: 'thread', accountId: 'a', threadId: 'a:t1' })
  expect(getNote(db, note.id)!.links.length).toBe(3)

  const other = saveNote(db, { title: 'About message 1', body: '', links: [{ kind: 'message', accountId: 'a', messageId: `a:t1-${first}` }] })
  expect(notesForThread(db, 'a', 'a:t1').map((n) => n.title).sort()).toEqual(['About message 1', 'Follow-ups'])
  expect(notesForThread(db, 'a', 'a:t2')).toEqual([])
  expect(notesForEvent(db, event.id).map((n) => n.id)).toEqual([note.id])

  // Deleting the event leaves the link, not live, with its snapshot.
  deleteEvent(db, event.id)
  expect(getNote(db, note.id)!.links[1]).toMatchObject({ live: false, snapshot: { title: 'Dentist' } })

  expect(unlinkNote(db, other.links[0]!.id)).toBe(true)
  expect(notesForThread(db, 'a', 'a:t1').map((n) => n.title)).toEqual(['Follow-ups'])
  expect(() => linkNote(db, note.id, { kind: 'message', accountId: 'a', messageId: 'a:t1-999' })).toThrow('Message not found')
  expect(() => linkNote(db, 'nope', { kind: 'contact', email: 'x@example.com' })).toThrow('Note not found')
  // Deleting a note deletes its links.
  deleteNote(db, note.id)
  expect(db.query('SELECT count(*) n FROM note_links').get()).toEqual({ n: 0 })
})
