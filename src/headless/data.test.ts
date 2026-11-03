import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from '../engine/db'
import { unreadAcrossAccounts } from '../engine/threads'
import { buildFixture } from './fixture'
import { isoLocal, meetingUrl, openJefiData, type JefiData } from './data'

let fixture: Awaited<ReturnType<typeof buildFixture>>
let data: JefiData

beforeAll(async () => {
  fixture = await buildFixture()
  data = openJefiData({ dir: fixture.dir })
})
afterAll(() => {
  data?.close()
  fixture?.cleanup()
})

test('accounts come from accounts.json with only id, name and email', () => {
  expect(data.accounts()).toEqual([{ id: fixture.accountId, name: 'Work', email: 'me@example.com' }])
  expect(JSON.stringify(data.accounts())).not.toContain('never-shown')
})

test('inbox threads map to the contract shape, newest first', () => {
  const inbox = data.inbox({ limit: 10 })
  expect(inbox.map((t) => t.subject).sort()).toEqual(['Invoice for March', 'Lunch', 'Planning sync'])
  const invoice = inbox.find((t) => t.subject === 'Invoice for March')!
  expect(invoice).toEqual({
    id: expect.stringContaining(`${fixture.accountId}:`),
    accountId: fixture.accountId,
    subject: 'Invoice for March',
    from: { name: 'Ada Lovelace', email: 'ada@example.com' },
    snippet: expect.any(String),
    date: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/),
    unread: true,
    starred: false,
    hasAttachments: true,
    url: `jefi://thread/${encodeURIComponent(invoice.id)}`,
  })
  expect(inbox.find((t) => t.subject === 'Lunch')!.unread).toBe(false)
  expect(data.inbox({ limit: 1 })).toHaveLength(1)
})

test('unread counts each inbox', () => {
  expect(data.unread()).toEqual({ total: 2, accounts: [{ id: fixture.accountId, email: 'me@example.com', unread: 2 }] })
  // The SQL count agrees with building the unread conversations, as it did before it was a count.
  const built = unreadAcrossAccounts(data.db, data.accounts().map((a) => ({ ...a, face: {} })), 100_000)
  expect(data.unread().total).toBe(built.length)
})

test('search uses the app search syntax', () => {
  expect(data.search('invoice').map((t) => t.subject)).toEqual(['Invoice for March'])
  expect(data.search('tacos').map((t) => t.subject)).toEqual(['Lunch'])
  expect(data.search('from:ada has:attachment').map((t) => t.subject)).toEqual(['Invoice for March'])
  expect(data.search('is:unread', { limit: 1 })).toHaveLength(1)
  expect(() => data.search('x', { account: 'nobody' })).toThrow(/No account/)
})

test('a thread reads as plain text, and an unknown one is an error', () => {
  const id = data.search('tacos')[0]!.id
  const { thread, messages } = data.thread(id)
  expect(thread.subject).toBe('Lunch')
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ from: { name: 'Bob', email: 'bob@example.com' }, subject: 'Lunch' })
  expect(messages[0]!.text).toContain('Tacos on Friday?')
  expect(() => data.thread(`${fixture.accountId}:nope`)).toThrow(/No conversation/)
})

test('today lists occurrences in start order, all-day first, with meeting links', () => {
  const today = data.today()
  expect(today.map((e) => e.title)).toEqual(['Offsite', 'Standup', 'Gym'])
  const [offsite, standup, gym] = today
  expect(offsite).toMatchObject({ allDay: true, start: isoLocal(fixture.today), meetingUrl: null })
  expect(standup!.meetingUrl).toBe('https://acme.zoom.us/j/123456?pwd=abc')
  expect(standup!.calendar).toEqual({ id: 'local', name: 'Personal', color: expect.any(String) })
  expect(standup!.url).toBe(`jefi://event/${encodeURIComponent(standup!.id)}?start=${standup!.occurrenceStart}`)
  expect(gym!.meetingUrl).toBeNull()
})

test('agenda expands repeating events over the days asked for', () => {
  const agenda = data.agenda(7)
  expect(agenda.filter((e) => e.title === 'Gym')).toHaveLength(5)
  expect(agenda.find((e) => e.title === 'Planning')!.meetingUrl).toBe('https://meet.google.com/abc-defg-hij')
  expect(data.agenda(1).filter((e) => e.title === 'Gym')).toHaveLength(1)
})

test('invites awaiting a reply', () => {
  expect(data.invites()).toEqual([
    {
      eventId: expect.any(String),
      title: 'Planning',
      start: expect.any(String),
      end: expect.any(String),
      allDay: false,
      organizer: { name: 'Nora', email: 'nora@example.com' },
      accountId: fixture.accountId,
      threadId: fixture.planningThreadId,
    },
  ])
})

test('notes list and read with their links', () => {
  expect(data.notes().map((n) => n.title)).toEqual(['Groceries', 'Trip ideas'])
  const [trip] = data.notes({ query: 'lisbon' })
  expect(trip).toMatchObject({ id: fixture.noteId, title: 'Trip ideas', snippet: 'Lisbon Tram 28, pastel de nata.' })
  expect(trip!.links).toEqual([{ kind: 'thread', title: expect.any(String), url: `jefi://thread/${encodeURIComponent(fixture.planningThreadId)}` }])
  expect(data.note(fixture.noteId).body).toContain('**pastel de nata**')
  expect(() => data.note('note-missing')).toThrow(/No note/)
})

test('never writes mail.db', () => {
  const before = statSync(`${fixture.dir}/mail.db`).mtimeMs
  data.inbox()
  data.search('invoice')
  data.today()
  data.invites()
  data.notes()
  expect(statSync(`${fixture.dir}/mail.db`).mtimeMs).toBe(before)
  expect(() => data.db.run('DELETE FROM notes')).toThrow(/readonly/)
})

test('reads while the app holds the database open and writes to it (WAL)', () => {
  const app = new Database(`${fixture.dir}/mail.db`)
  app.exec('PRAGMA journal_mode = WAL')
  app.run("UPDATE notes SET title = 'Groceries!' WHERE title = 'Groceries'")
  expect(data.notes().map((n) => n.title)).toContain('Groceries!')
  app.run("UPDATE notes SET title = 'Groceries' WHERE title = 'Groceries!'")
  app.close()
})

test('a missing folder, a missing mail.db and another schema are clear errors', () => {
  expect(() => openJefiData({ dir: `${fixture.dir}/absent` })).toThrow(/data folder isn't there/)
  const empty = `${fixture.dir}/empty`
  require('node:fs').mkdirSync(empty)
  expect(() => openJefiData({ dir: empty })).toThrow(/No mail.db/)
  const old = new Database(`${empty}/mail.db`)
  old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`)
  old.close()
  expect(() => openJefiData({ dir: empty })).toThrow(/older than this build/)
  const newer = new Database(`${empty}/mail.db`)
  newer.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`)
  newer.close()
  expect(() => openJefiData({ dir: empty })).toThrow(/upgraded by a newer Jefi in a way this version .* can't use/)
  // The version check never migrated it.
  const check = new Database(`${empty}/mail.db`, { readonly: true })
  expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length + 1)
  check.close()
  expect(existsSync(`${fixture.dir}/absent`)).toBe(false)
})

test('meetingUrl prefers a meeting service over any other https link', () => {
  expect(meetingUrl('Room 4', 'Agenda https://docs.example.com/x, join https://teams.microsoft.com/l/meetup-join/1.')).toBe('https://teams.microsoft.com/l/meetup-join/1')
  expect(meetingUrl('https://acme.webex.com/meet/ada')).toBe('https://acme.webex.com/meet/ada')
  expect(meetingUrl(null, 'See https://example.com/call')).toBe('https://example.com/call')
  expect(meetingUrl('http://insecure.example.com', 'no links')).toBeNull()
})

test('isoLocal carries the local offset', () => {
  const t = Date.UTC(2026, 2, 3, 12, 0, 0)
  expect(new Date(isoLocal(t)).getTime()).toBe(t)
  expect(isoLocal(t)).toMatch(/[+-]\d\d:\d\d$/)
})
