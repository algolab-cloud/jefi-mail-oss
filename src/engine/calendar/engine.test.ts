import { afterEach, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from '../db'
import { createImapEngine } from '../imap-engine'
import { ensureAccount } from '../mail-store'
import type { SecretStore } from '../secrets'
import { fetchBodies, syncAccount } from '../sync'
import { USER, startImapServer } from '../testing/imap-server'
import { uiThreadId } from '../threading'
import type { EngineEvent } from '../types'

// The engine's calendar and notes API end to end: invites stored as mail syncs, and the events
// that tell the UI to refresh.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const ICS = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Example//Calendar//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:kickoff-123@organizer.example',
  'SEQUENCE:0',
  'DTSTART:20260310T150000Z',
  'DTEND:20260310T160000Z',
  'SUMMARY:Kickoff',
  'ORGANIZER;CN=Boss:mailto:boss@example.com',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** An invite the way calendar apps send one: text, an inline text/calendar alternative, and an .ics attachment. */
const invite = (n: number, extra: string[] = []) =>
  [
    'From: Boss <boss@example.com>',
    'To: Me <me@example.com>',
    `Subject: Invitation: Kickoff ${n}`,
    `Message-ID: <invite${n}@example.com>`,
    `Date: ${new Date(Date.UTC(2026, 2, 1, 9, n)).toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'You are invited to the kickoff.',
    '--alt',
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
    '',
    ICS,
    '--alt--',
    ...extra,
    '--mix',
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(ICS.replace('METHOD:REQUEST', 'METHOD:PUBLISH')).toString('base64'),
    '--mix--',
    '',
  ].join('\r\n')

/** A big attachment, so the message is past the whole-fetch size and takes the text-only path. */
const bigPart = ['--mix', 'Content-Type: application/pdf; name="deck.pdf"', 'Content-Disposition: attachment; filename="deck.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.alloc(300_000, 7).toString('base64').replace(/.{76}/g, '$&\r\n')]

const memorySecrets = (values: Record<string, string>): SecretStore => ({
  get: async (id) => values[id] ?? null,
  set: async () => {},
  delete: async () => {},
})

const messageOf = (db: MailDatabase, n: number) => {
  const row = db.query('SELECT id, account_id, thread_id FROM messages WHERE message_id = ?').get(`<invite${n}@example.com>`) as { id: number; account_id: string; thread_id: string | null }
  return { threadId: uiThreadId(row.account_id, row.thread_id, row.id), messageId: `${uiThreadId(row.account_id, row.thread_id, row.id)}-${row.id}` }
}

const expectedInvites = [
  { index: 0, method: 'REQUEST', filename: null, ics: ICS },
  { index: 1, method: 'PUBLISH', filename: 'invite.ics', ics: ICS.replace('METHOD:REQUEST', 'METHOD:PUBLISH') },
]

test('text/calendar parts are stored with the body, whole-fetched or text-only, and cleared with it', async () => {
  const server = await startImapServer({ INBOX: [{ raw: invite(1) }, { raw: invite(2, bigPart) }] })
  const client = await server.connect()
  const db = openDatabase(':memory:')
  ensureAccount(db, server.account.id, server.account.email)
  cleanups.push(() => server.close(), () => client.logout().catch(() => client.close()), () => db.close())
  await syncAccount(client, db, server.account.id)
  // Whole sources up to 64 KB; the one with the big attachment goes text-only and still gets its invites.
  expect(await fetchBodies(client, db, server.account.id, 10, undefined, 64 * 1024)).toBe(2)

  const engine = createImapEngine({ database: () => db, secrets: memorySecrets({}), watch: false, wake: false })
  cleanups.push(() => engine.dispose())
  for (const n of [1, 2]) expect(await engine.invitesForMessage(server.account.id, messageOf(db, n).messageId)).toEqual(expectedInvites)
  // The deck was not downloaded to get there.
  expect((db.query("SELECT size_estimated FROM attachments WHERE filename = 'deck.pdf'").get() as { size_estimated: number }).size_estimated).toBe(1)
  // Another account's view of the id, or a malformed one, finds nothing.
  expect(await engine.invitesForMessage('someone-else', messageOf(db, 1).messageId)).toEqual([])
  expect(await engine.invitesForMessage(server.account.id, 'nonsense')).toEqual([])
})

test('the engine stores invites as it syncs, emits calendar and notes changes, and account removal detaches links', async () => {
  const server = await startImapServer({ INBOX: [{ raw: invite(1) }] })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: memorySecrets({ [server.account.id]: USER.pass }), watch: false, wake: false, bodyLimit: 10 })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  const started = Date.now()
  // Stored, and applied to the calendar (invites.ts), so the events below are only the test's own.
  while (!(db.query('SELECT count(*) n FROM invite_state').get() as { n: number }).n) {
    if (Date.now() - started > 10_000) throw new Error('no invites stored')
    await Bun.sleep(20)
  }
  const { threadId, messageId } = messageOf(db, 1)
  expect(await engine.invitesForMessage(server.account.id, messageId)).toEqual(expectedInvites)

  const seen = (from: number) => events.slice(from).filter((e) => e.type === 'calendarChanged' || e.type === 'notesChanged' || e.type === 'tasksChanged')
  let mark = events.length
  const [calendar] = await engine.listCalendars()
  const event = await engine.saveEvent({
    uid: 'kickoff-123@organizer.example',
    accountId: server.account.id,
    title: 'Kickoff',
    startAt: Date.UTC(2026, 2, 10, 15),
    endAt: Date.UTC(2026, 2, 10, 16),
    invite: { kind: 'message', accountId: server.account.id, messageId },
  })
  expect(seen(mark)).toEqual([{ type: 'calendarChanged', calendarIds: [calendar!.id] }])
  expect(await engine.eventsForThread(server.account.id, threadId)).toEqual([event])
  expect((await engine.eventByUid('kickoff-123@organizer.example'))!.id).toBe(event.id)
  expect((await engine.listEvents(Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1))).map((o) => o.key)).toEqual([event.id])

  mark = events.length
  const note = await engine.saveNote({ title: 'Prep', body: 'Slides', links: [{ kind: 'thread', accountId: server.account.id, threadId }] })
  const link = await engine.linkNote(note.id, { kind: 'event', eventId: event.id })
  await engine.unlinkNote(link.id)
  expect(seen(mark)).toEqual([0, 1, 2].map(() => ({ type: 'notesChanged', noteIds: [note.id] })))
  expect((await engine.notesForThread(server.account.id, threadId)).map((n) => n.id)).toEqual([note.id])

  mark = events.length
  const task = await engine.saveTask({ title: 'Reply to the invite', origin: 'email', links: [{ kind: 'message', accountId: server.account.id, messageId }] })
  await engine.setTaskDone(task.id, true)
  const taskLink = await engine.linkTask(task.id, { kind: 'event', eventId: event.id })
  await engine.unlinkTask(taskLink.id)
  expect(seen(mark)).toEqual([0, 1, 2, 3].map(() => ({ type: 'tasksChanged', taskIds: [task.id] })))
  expect((await engine.tasksForThread(server.account.id, threadId)).map((t) => [t.id, t.status])).toEqual([[task.id, 'done']])

  // Failed writes reject with a message and emit nothing.
  mark = events.length
  await expect(engine.saveEvent({ title: 'Bad', startAt: 2, endAt: 1 })).rejects.toThrow('end before it starts')
  await expect(engine.deleteCalendar(calendar!.id)).rejects.toThrow('at least one calendar')
  await expect(engine.saveTask({ title: ' ' })).rejects.toThrow('A task needs a title')
  expect(seen(mark)).toEqual([])

  mark = events.length
  await engine.forgetAccount(server.account.id)
  expect(seen(mark)).toEqual([{ type: 'calendarChanged' }, { type: 'notesChanged' }, { type: 'tasksChanged' }])
  expect((await engine.getTask(task.id))!.links).toEqual([expect.objectContaining({ live: false, target: { kind: 'message', accountId: null } })])
  const [kept] = await engine.listNotes()
  expect(kept!.links).toEqual([expect.objectContaining({ live: false, target: { kind: 'thread', accountId: null }, snapshot: expect.objectContaining({ subject: 'Invitation: Kickoff 1' }) })])
  const after = (await engine.getEvent(event.id))!
  expect([after.accountId, after.uid, after.invite?.live, after.invite?.snapshot.subject]).toEqual([null, 'kickoff-123@organizer.example', false, 'Invitation: Kickoff 1'])
})

test('a synced invite is pending (with its conversation) until answered, and calendarChanged says when that changes', async () => {
  const server = await startImapServer({ INBOX: [{ raw: invite(1) }] })
  const db = openDatabase(':memory:')
  const engine = createImapEngine({ database: () => db, secrets: memorySecrets({ [server.account.id]: USER.pass }), watch: false, wake: false, bodyLimit: 10 })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => server.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  const started = Date.now()
  while (!events.some((e) => e.type === 'calendarChanged')) {
    if (Date.now() - started > 10_000) throw new Error('no invite applied')
    await Bun.sleep(20)
  }
  const before = Date.UTC(2026, 2, 1)
  const { threadId, messageId } = messageOf(db, 1)
  const [pending, ...rest] = await engine.pendingInvites(before)
  expect(rest).toEqual([])
  expect(pending).toMatchObject({ title: 'Kickoff', startAt: Date.UTC(2026, 2, 10, 15), endAt: Date.UTC(2026, 2, 10, 16), organizer: { email: 'boss@example.com', name: 'Boss' }, accountId: server.account.id, threadId, messageId, recurring: false })
  expect(pending!.eventId).toBe((await engine.eventByUid('kickoff-123@organizer.example'))!.id)
  // Once it's over it isn't pending any more.
  expect(await engine.pendingInvites(Date.UTC(2026, 2, 10, 16))).toEqual([])

  const mark = events.length
  await engine.respondToInvite(server.account.id, messageId, 'accepted')
  expect(events.slice(mark).some((e) => e.type === 'calendarChanged')).toBe(true)
  expect(await engine.pendingInvites(before)).toEqual([])
})
