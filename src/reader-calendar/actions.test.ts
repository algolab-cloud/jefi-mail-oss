import { afterEach, expect, test } from 'bun:test'
import type { Message } from '../data'
import { eventLinks, eventsForThread, saveEvent } from '../engine/calendar/store'
import { getNote, linkNote, notesForThread, saveNote } from '../engine/calendar/notes'
import { openDatabase, type MailDatabase } from '../engine/db'
import { ensureAccount } from '../engine/mail-store'
import { addToNewNote, appendToNote, quickAddEvent, threadEventsWithLinks, type ReaderApi } from './actions'
import { eventsForMessage } from './suggest'
import { threadChips } from './thread-links'

const dbs: MailDatabase[] = []
afterEach(() => {
  while (dbs.length) dbs.pop()!.close()
})

// The reader's actions over the engine's real calendar and notes storage.
function setup() {
  const db = openDatabase(':memory:')
  dbs.push(db)
  ensureAccount(db, 'a', 'a@example.com')
  const insert = (n: number) => {
    db.run("INSERT INTO messages (account_id, message_id, thread_id, subject, from_email, date) VALUES ('a', ?, 't1', 'Q3 review', 'lea@atlas.dev', ?)", [`<n${n}@example.com>`, n])
    return `a:t1-${(db.query('SELECT last_insert_rowid() id').get() as { id: number }).id}`
  }
  const api: ReaderApi = {
    saveEvent: async (input) => saveEvent(db, input),
    eventLinks: async (id) => eventLinks(db, id),
    saveNote: async (input) => saveNote(db, input),
    getNote: async (id) => getNote(db, id),
    linkNote: async (id, target) => linkNote(db, id, target),
    threadTarget: (threadId) => ({ kind: 'thread', accountId: 'a', threadId }),
    messageTarget: (_threadId, messageId) => ({ kind: 'message', accountId: 'a', messageId }),
  }
  return { db, api, first: insert(1), second: insert(2) }
}

const thread = { id: 'a:t1', subject: 'Re: Q3 review' }
const message = (id: string, text: string): Message => ({ id, from: 'Lea Ortiz', email: 'lea@atlas.dev', to: 'me', face: { letter: 'L' } as Message['face'], time: '', timestamp: Date.UTC(2026, 8, 22), paragraphs: [text] })

const draft = { title: 'Design review', date: '2026-10-02', endDate: '2026-10-02', startTime: '15:00', endTime: '16:00', allDay: false, calendarId: null }

test('quick add creates the event linked to the message, which then reads as added', async () => {
  const { db, api, first, second } = setup()
  const result = await quickAddEvent(api, draft, 'a:t1', first, 'Europe/Berlin')
  if (!result.ok) throw new Error(result.error)
  expect(result.event).toMatchObject({ title: 'Design review', startAt: Date.UTC(2026, 9, 2, 13), endAt: Date.UTC(2026, 9, 2, 14), calendarId: 'local', timeZone: 'Europe/Berlin' })
  expect(eventLinks(db, result.event.id).map((l) => l.target)).toEqual([{ kind: 'message', accountId: 'a', messageId: first }])

  const withLinks = await threadEventsWithLinks(eventsForThread(db, 'a', 'a:t1'), api.eventLinks)
  expect(eventsForMessage(withLinks, first).map((e) => e.id)).toEqual([result.event.id])
  expect(eventsForMessage(withLinks, second)).toEqual([])

  // A bad form never reaches the engine.
  expect(await quickAddEvent(api, { ...draft, startTime: 'noon-ish' }, 'a:t1', first)).toEqual({ ok: false, error: 'Use times like 15:00' })
  expect(eventsForThread(db, 'a', 'a:t1').length).toBe(1)
})

test('add to notes: a new note, then appending another message to it', async () => {
  const { db, api, first, second } = setup()
  const note = await addToNewNote(api, thread, message(first, 'Numbers attached.'))
  expect(note).toMatchObject({ title: 'Q3 review' })
  expect(note!.body).toContain('> Numbers attached.')
  expect(note!.links.map((l) => l.target)).toEqual([
    { kind: 'thread', accountId: 'a', threadId: 'a:t1' },
    { kind: 'message', accountId: 'a', messageId: first },
  ])

  const appended = await appendToNote(api, note!.id, thread, message(second, 'One more thing.'))
  expect(appended!.body).toContain('> Numbers attached.\n\n---\n\n**Lea Ortiz**')
  expect(appended!.body.endsWith('> One more thing.')).toBe(true)
  expect(appended!.links.length).toBe(3)
  expect(notesForThread(db, 'a', 'a:t1').map((n) => n.id)).toEqual([note!.id])
  expect(await appendToNote(api, 'note-missing', thread, message(second, 'x'))).toBeNull()
})

test('chips: events soonest first (cancelled left out), then notes latest first', async () => {
  const { db, api, first } = setup()
  const later = saveEvent(db, { title: 'Follow-up', startAt: Date.UTC(2026, 9, 9, 8), endAt: Date.UTC(2026, 9, 9, 9), timeZone: 'UTC', links: [api.threadTarget('a:t1')] })
  const sooner = saveEvent(db, { title: 'Offsite', startAt: Date.UTC(2026, 9, 5), endAt: Date.UTC(2026, 9, 7), allDay: true, links: [api.messageTarget('a:t1', first)] })
  saveEvent(db, { title: 'Dropped', startAt: 1, endAt: 2, status: 'cancelled', links: [api.threadTarget('a:t1')] })
  const a = await addToNewNote(api, thread, message(first, 'a'))
  await Bun.sleep(2)
  const b = saveNote(db, { title: 'Budget', body: '', links: [api.threadTarget('a:t1')] })
  const chips = threadChips(eventsForThread(db, 'a', 'a:t1'), notesForThread(db, 'a', 'a:t1'), 'UTC', 'en-GB')
  expect(chips.map((c) => [c.kind, c.id, c.label, c.detail])).toEqual([
    ['event', sooner.id, 'Offsite', 'Mon 5 Oct – Tue 6 Oct'],
    ['event', later.id, 'Follow-up', 'Fri 9 Oct, 8:00–9:00'],
    ['note', b.id, 'Budget', undefined],
    ['note', a!.id, 'Q3 review', undefined],
  ])
})
