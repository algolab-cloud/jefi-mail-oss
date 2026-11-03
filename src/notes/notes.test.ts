import { expect, test } from 'bun:test'
import { appendedAtEnd, endInView, needsFollow } from './follow-end'
import type { Link, LinkTarget, Note, NoteInput, NoteLink } from '../engine'
import { openDatabase } from '../engine/db'
import * as store from '../engine/calendar/notes'
import { createLocalData, applyLocalEvent } from '../local-data'
import { notesKeyFor } from '../shortcuts'
import { addEmailToNote } from './add-email'
import { createAutosaver } from './autosave'
import { appendBlock, checklistProgress, firstLine, noteBlocks, noteGroup, rowTime, toggleTask, wordCount, linkView, liveFirst, mailDestination, noteHeading, notePreview, orderNotes, quoteEmail, restorableTargets, searchQuery } from './model'

const link = (over: Partial<Link>): Link => ({ id: 'l', target: { kind: 'thread', accountId: 'a', threadId: 'a:t1' }, snapshot: {}, live: true, createdAt: 1, ...over })

test('rows: pinned first then latest edited; headings and previews from markdown', () => {
  const notes = [
    { id: 'a', pinned: false, updatedAt: 5 },
    { id: 'b', pinned: true, updatedAt: 1 },
    { id: 'c', pinned: false, updatedAt: 9 },
    { id: 'd', pinned: true, updatedAt: 3 },
  ]
  expect(orderNotes(notes).map((n) => n.id)).toEqual(['d', 'b', 'c', 'a'])
  expect(firstLine('\n## **Plan** for [Q3](https://x)\nmore')).toBe('Plan for Q3')
  expect(firstLine('- [ ] buy milk')).toBe('buy milk')
  expect(noteHeading({ title: '  ', body: '> quoted start\nsecond' })).toBe('quoted start')
  expect(noteHeading({ title: '', body: '' })).toBe('New note')
  expect(notePreview({ title: '', body: 'one\n\ntwo' })).toBe('two')
  expect(notePreview({ title: 'T', body: '\n# one' })).toBe('one')
})

test('search: blank input lists everything; the engine query is trimmed and single-spaced', () => {
  expect(searchQuery('   ')).toBe('')
  expect(searchQuery('  launch   plan ')).toBe('launch plan')
})

test('search wiring: useNotes queries reach the notes FTS, and notesChanged refetches', async () => {
  const db = openDatabase(':memory:')
  store.saveNote(db, { title: 'Launch checklist', body: 'freeze' })
  store.saveNote(db, { title: 'Groceries', body: 'milk', pinned: true })
  const calls: Array<string | undefined> = []
  const data = createLocalData({
    listCalendars: async () => [],
    listEvents: async () => [],
    listNotes: async (query) => (calls.push(query), store.listNotes(db, query)),
    notesForThread: async () => [],
    eventsForThread: async () => [],
    notesForEvent: async () => [],
    listTasks: async () => [],
    tasksForThread: async () => [],
    listTaskProjects: async () => [],
    listTaskLabels: async () => [],
    pendingInvites: async () => [],
  })
  expect((await data.engine.listNotes('laun')).map((n) => n.title)).toEqual(['Launch checklist'])
  expect((await data.engine.listNotes()).map((n) => n.title)).toEqual(['Groceries', 'Launch checklist'])
  const rev = data.notesRev
  expect(applyLocalEvent(data, { type: 'notesChanged' })).toBe(true)
  expect(data.notesRev).toBe(rev + 1)
  expect(calls).toEqual(['laun', undefined])
  db.close()
})

test('link rendering: live, gone and detached mail; events; contacts', () => {
  const now = new Date(2026, 8, 26, 12).getTime()
  const snapshot = { subject: 'Q3 review', from: { name: 'Lea Ortiz', email: 'lea@atlas.dev' }, date: new Date(2026, 8, 26, 9, 5).getTime() }
  expect(linkView(link({ snapshot }), now)).toMatchObject({ icon: 'mail', primary: 'Lea Ortiz', secondary: 'Q3 review', when: '9:05 AM', state: 'live' })
  expect(linkView(link({ snapshot, live: false }), now)).toMatchObject({ state: 'gone', note: 'No longer in your mailbox' })
  expect(linkView(link({ snapshot, live: false, target: { kind: 'message', accountId: null } }), now)).toMatchObject({ state: 'detached', primary: 'Lea Ortiz' })
  expect(linkView(link({ snapshot: {}, target: { kind: 'thread', accountId: 'a', threadId: 'x' } }), now)).toMatchObject({ primary: 'Email', secondary: '(no subject)' })
  expect(linkView(link({ target: { kind: 'event', eventId: 'e' }, snapshot: { title: 'Standup' }, live: false }))).toMatchObject({ icon: 'calendar', primary: 'Standup', state: 'gone' })
  expect(linkView(link({ target: { kind: 'contact', email: 'n@h.io' }, snapshot: { name: 'Nora', email: 'n@h.io' } }))).toMatchObject({ icon: 'user', primary: 'Nora', secondary: 'n@h.io' })

  expect(mailDestination({ kind: 'message', accountId: 'a', messageId: 'a:t-1-42' })).toEqual({ accountId: 'a', threadId: 'a:t-1' })
  expect(mailDestination({ kind: 'thread', accountId: null })).toBeNull()
  const links = [link({ id: 'gone', live: false, createdAt: 0 }), link({ id: 'b', createdAt: 2 }), link({ id: 'a', createdAt: 1 })]
  expect(liveFirst(links).map((l) => l.id)).toEqual(['a', 'b', 'gone'])
  expect(restorableTargets({ links: [link({}), link({ target: { kind: 'thread', accountId: null } })] as NoteLink[] })).toHaveLength(1)
})

test('email quotes: excerpt as a markdown quote with its sender, appended after a blank line', () => {
  const snap = { subject: 'Hi', from: { name: 'Lea', email: 'l@a.dev' }, date: new Date(2026, 8, 1).getTime() }
  expect(quoteEmail('one\n\ntwo', snap)).toBe('> one\n>\n> two\n>\n> — Lea, Sep 1, 2026')
  expect(quoteEmail(undefined, snap)).toBe('From Lea, Sep 1, 2026: “Hi”')
  expect(appendBlock('', 'x')).toBe('x\n')
  expect(appendBlock('a\n\n', 'x')).toBe('a\n\nx\n')
})

/** The store's note actions over a real notes database, with its engine snapshotting mail. */
function actions() {
  const db = openDatabase(':memory:')
  db.run("INSERT INTO accounts (id, email, created_at) VALUES ('a', 'a@example.com', 1)")
  db.run("INSERT INTO messages (account_id, message_id, thread_id, subject, from_name, from_email, date) VALUES ('a', '<m1@x>', 't1', 'Q3 review', 'Lea Ortiz', 'lea@atlas.dev', 5)")
  const row = (db.query('SELECT last_insert_rowid() id').get() as { id: number }).id
  return {
    db,
    messageId: `a:t1-${row}`,
    saveNote: async (input: NoteInput) => store.saveNote(db, input),
    getNote: async (id: string) => store.getNote(db, id),
    linkNote: async (id: string, target: LinkTarget) => store.linkNote(db, id, target),
  }
}

test('addEmailToNote: a new note titled with the subject, quoting the excerpt and linking the mail', async () => {
  const a = actions()
  const note = (await addEmailToNote(a, { accountId: 'a', threadId: 'a:t1', messageId: a.messageId, excerpt: 'Numbers please' }))!
  expect(note.title).toBe('Q3 review')
  expect(note.body).toStartWith('> Numbers please\n>\n> — Lea Ortiz,')
  expect(note.links.map((l) => [l.target, l.live])).toEqual([[{ kind: 'message', accountId: 'a', messageId: a.messageId }, true]])
  expect(store.listNotes(a.db)).toHaveLength(1)
})

test('addEmailToNote: appends to an existing note and adds the link', async () => {
  const a = actions()
  const existing = store.saveNote(a.db, { title: 'Prep', body: 'My thoughts' })
  const note = (await addEmailToNote(a, { accountId: 'a', threadId: 'a:t1' }, existing.id))!
  expect(note.id).toBe(existing.id)
  expect(note.title).toBe('Prep')
  expect(note.body).toStartWith('My thoughts\n\nFrom Lea Ortiz,')
  expect(note.links.map((l) => l.target)).toEqual([{ kind: 'thread', accountId: 'a', threadId: 'a:t1' }])
})

test('addEmailToNote: resolves null when a write fails (the store has toasted)', async () => {
  const a = actions()
  expect(await addEmailToNote({ ...a, linkNote: async () => null }, { accountId: 'a', threadId: 'a:t1' }, 'note-x')).toBeNull()
  expect(await addEmailToNote({ ...a, saveNote: async () => null as Note | null }, { accountId: 'a', threadId: 'a:t1' })).toBeNull()
})

test('autosave: debounces edits into one save, queues edits made while saving, flushes on demand', async () => {
  const saved: string[] = []
  let release: (() => void) | null = null
  const saver = createAutosaver<string>({
    delay: 20,
    save: (v) => {
      saved.push(v)
      return new Promise<string>((r) => (release = () => r(v)))
    },
  })
  const states: string[] = []
  saver.subscribe(() => states.push(saver.state()))
  saver.schedule('a')
  saver.schedule('ab')
  saver.schedule('abc')
  await Bun.sleep(40)
  expect(saved).toEqual(['abc'])
  expect(saver.state()).toBe('saving')
  saver.schedule('abcd')
  await Bun.sleep(40)
  // Never two saves at once: the next waits for the first.
  expect(saved).toEqual(['abc'])
  release!()
  await Bun.sleep(5)
  expect(saved).toEqual(['abc', 'abcd'])
  release!()
  await Bun.sleep(5)
  expect(saver.state()).toBe('saved')
  saver.schedule('x')
  const flushed = saver.flush()
  // Flushing saves at once, without waiting out the delay.
  expect(saved).toEqual(['abc', 'abcd', 'x'])
  release!()
  await flushed
  expect(saved).toEqual(['abc', 'abcd', 'x'])
  saver.schedule('dropped')
  saver.cancel()
  await Bun.sleep(40)
  expect(saved).toHaveLength(3)
  expect(states.slice(0, 2)).toEqual(['pending', 'saving'])
})

test('autosave: a save resolving null reads as failed', async () => {
  const saver = createAutosaver<string>({ delay: 1, save: async () => null })
  saver.schedule('x')
  await saver.flush()
  expect(saver.state()).toBe('failed')
})

test('notes keys: n only when not typing, ⌘F searches, Esc', () => {
  expect(notesKeyFor({ key: 'n' }, { typing: false })).toBe('newNote')
  expect(notesKeyFor({ key: 'n' }, { typing: true })).toBeNull()
  expect(notesKeyFor({ key: 'n', modifiers: { cmd: true } }, { typing: false })).toBeNull()
  expect(notesKeyFor({ key: 'f', modifiers: { cmd: true } }, { typing: true })).toBe('search')
  expect(notesKeyFor({ key: 'f' }, { typing: false })).toBeNull()
  expect(notesKeyFor({ key: 'escape' }, { typing: true })).toBe('escape')
})

test('the page follows typing at the end of a long field, not edits in the middle', () => {
  expect(appendedAtEnd('Line 1\nLine 2', 'Line 1\nLine 2\n')).toBe(true)
  expect(appendedAtEnd('Line 1\nLine 2', 'Line 1\nLine 2x')).toBe(true)
  expect(appendedAtEnd('Line 1\nLine 2', 'Line 1x\nLine 2')).toBe(false)
  expect(appendedAtEnd('Line 1\nLine 2', 'Line 1\nLine ')).toBe(false)
  expect(appendedAtEnd('same', 'same')).toBe(false)
})

test('typing at the end scrolls the page only when the field grew or the page moved', () => {
  // Nothing measured yet, or no field to measure: scroll, as before.
  expect(needsFollow(null, 400, -100)).toBe(true)
  expect(needsFollow({ height: 400, offset: -100 }, undefined, -100)).toBe(true)
  // The last scroll hasn't settled yet.
  expect(needsFollow({ height: 400, offset: undefined }, 400, -100)).toBe(true)
  // Same line, page still at the end: nothing to do.
  expect(needsFollow({ height: 400, offset: -100 }, 400, -100)).toBe(false)
  // A new line, or the page scrolled away since.
  expect(needsFollow({ height: 400, offset: -100 }, 424, -100)).toBe(true)
  expect(needsFollow({ height: 400, offset: -100 }, 400, -40)).toBe(true)
})

test('the list heads notes by when they were last edited', () => {
  const now = new Date(2026, 8, 28, 15, 0).getTime()
  const at = (days: number, hour = 9) => new Date(2026, 8, 28 - days, hour).getTime()
  expect(noteGroup(at(0), now)).toBe('Today')
  expect(noteGroup(at(1, 23), now)).toBe('Yesterday')
  expect(noteGroup(at(6), now)).toBe('Previous 7 days')
  expect(noteGroup(at(7), now)).toBe('Previous 30 days')
  expect(noteGroup(at(45), now)).toBe('Earlier')
  // Under Yesterday the row gives the time, not the day again; further back it gives the day.
  expect(rowTime(at(1, 9), now)).toBe('9:00 AM')
  expect(rowTime(at(3), now)).toBe(new Date(at(3)).toLocaleDateString('en-US', { weekday: 'long' }))
})

test('the read view splits a body into Markdown runs and the checklist items it can tick', () => {
  const body = 'Freeze on Thursday.\n\n- [ ] Changelog\n  - [x] **Pricing** page\n- [ ]\n\n## After\n```\n- [ ] not a task in code\n```'
  expect(noteBlocks(body)).toEqual([
    { kind: 'text', source: 'Freeze on Thursday.' },
    { kind: 'task', line: 2, done: false, text: 'Changelog', indent: 0 },
    { kind: 'task', line: 3, done: true, text: '**Pricing** page', indent: 1 },
    { kind: 'task', line: 4, done: false, text: '', indent: 0 },
    { kind: 'text', source: '## After\n```\n- [ ] not a task in code\n```' },
  ])
})

test('ticking changes only that item’s box, both ways', () => {
  const body = '- [ ] Changelog\n- [x] Pricing [draft]\nPlain line'
  expect(toggleTask(body, 0)).toBe('- [x] Changelog\n- [x] Pricing [draft]\nPlain line')
  expect(toggleTask(body, 1)).toBe('- [ ] Changelog\n- [ ] Pricing [draft]\nPlain line')
  // Not a checklist item, or past the end: nothing changes.
  expect(toggleTask(body, 2)).toBe(body)
  expect(toggleTask(body, 9)).toBe(body)
})

test('a row shows checklist progress only when the note has one', () => {
  expect(checklistProgress('- [ ] a\n- [x] b\n- [X] c')).toEqual({ done: 2, total: 3 })
  expect(checklistProgress('- a\n- b')).toBeNull()
})

test('words are counted without Markdown markers', () => {
  expect(wordCount('## To bring\n- Revenue by plan, **July–September**\n> — Lea')).toBe(7)
  expect(wordCount('a two-minute import')).toBe(3)
  expect(wordCount('  \n- \n')).toBe(0)
})

test('a field whose end is already on the page is not followed', () => {
  const page = { y: 60, height: 800 }
  expect(endInView(page, { y: 200, height: 240 })).toBe(true)
  expect(endInView(page, { y: 200, height: 700 })).toBe(false)
  // Not laid out yet: follow as before.
  expect(endInView(undefined, { y: 200, height: 240 })).toBe(false)
})
