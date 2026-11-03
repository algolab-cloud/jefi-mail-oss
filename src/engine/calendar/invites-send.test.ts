import { afterEach, expect, test } from 'bun:test'
import { simpleParser } from 'mailparser'
import { parseIcs } from '../../detect/ics'
import { openDatabase } from '../db'
import { createImapEngine } from '../imap-engine'
import { getOutgoing } from '../outbox'
import type { SecretStore } from '../secrets'
import { selfSignedCert, startFakeSmtp } from '../testing/fake-servers'
import { USER, startImapServer } from '../testing/imap-server'
import { uiThreadId } from '../threading'
import type { EngineEvent } from '../types'

// Invitations end to end: an invite synced from IMAP lands in the calendar, answering it sends an
// iTIP REPLY through the outbox and SMTP from the receiving account, and events Jefi organizes send
// REQUEST / CANCEL. The MIME structure and the iCalendar inside are checked on the bytes SMTP got.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const cert = selfSignedCert()

const ICS = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:kickoff-123@google.com',
  'SEQUENCE:2',
  'DTSTART:20260310T150000Z',
  'DTEND:20260310T160000Z',
  'DTSTAMP:20260301T090000Z',
  'SUMMARY:Kickoff',
  'ORGANIZER;CN=Boss:mailto:boss@example.com',
  `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Me:mailto:${USER.user}`,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

// How Gmail sends one: text + inline text/calendar, and the same again as invite.ics.
const invite = [
  'From: Boss <boss@example.com>',
  `To: Me <${USER.user}>`,
  'Subject: Invitation: Kickoff',
  'Message-ID: <invite1@example.com>',
  'Date: Sun, 01 Mar 2026 09:00:00 +0000',
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
  '--mix',
  'Content-Type: application/ics; name="invite.ics"',
  'Content-Disposition: attachment; filename="invite.ics"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(ICS).toString('base64'),
  '--mix--',
  '',
].join('\r\n')

async function setup() {
  const imap = await startImapServer({ INBOX: [{ raw: invite }], Sent: { 'special-use': '\\Sent', messages: [] } })
  const smtp = await startFakeSmtp({ cert, users: [USER] })
  const db = openDatabase(':memory:')
  const account = { ...imap.account, name: 'Mara Lin', servers: { ...imap.account.servers, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'ssl' as const } }
  const secrets: SecretStore = { get: async () => USER.pass, set: async () => {}, delete: async () => {} }
  const engine = createImapEngine({ database: () => db, secrets, wake: false, watch: false, bodyLimit: 10, connectOptions: { allowInvalidCerts: true, timeoutMs: 3000 } })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  cleanups.push(() => imap.close(), () => smtp.close(), () => db.close(), () => engine.dispose())
  engine.setAccounts([account])
  return { imap, smtp, db, account, engine, events }
}

const waitFor = async <T>(fn: () => T | undefined | false | null, ms = 8000): Promise<T> => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const value = fn()
    if (value) return value
    await Bun.sleep(20)
  }
  throw new Error('timed out')
}

const states = (events: EngineEvent[], id: string) => events.flatMap((e) => (e.type === 'outboxState' && e.threadId === id ? [e.state] : []))

/** The Content-Type headers of every MIME part, in order, lowercased and unfolded. */
const contentTypes = (raw: string) => [...raw.replace(/\r\n[ \t]+/g, ' ').matchAll(/^content-type:\s*([^\r\n]+)/gim)].map((m) => m[1]!.toLowerCase().replace(/;\s*boundary=.*/, ''))

/** A part's decoded body by its Content-Type prefix. */
async function partText(raw: string, type: string) {
  const parsed = await simpleParser(raw)
  const part = parsed.attachments.find((a) => a.contentType === type)
  return part?.content.toString('utf8')
}

test('a synced invite goes into the calendar; answering it sends a REPLY to the organizer from that account', async () => {
  const { smtp, db, account, engine, events } = await setup()
  engine.syncNow(account.id, true)
  await waitFor(() => (db.query('SELECT count(*) n FROM invite_state').get() as { n: number }).n)
  const row = db.query('SELECT id, thread_id FROM messages WHERE message_id = ?').get('<invite1@example.com>') as { id: number; thread_id: string | null }
  const messageId = `${uiThreadId(account.id, row.thread_id, row.id)}-${row.id}`

  const card = (await engine.inviteForMessage(account.id, messageId))!
  expect(card).toMatchObject({ method: 'REQUEST', state: 'applied', title: 'Kickoff', sequence: 2, response: 'needs-action', organizer: { email: 'boss@example.com', name: 'Boss' } })
  expect(events.some((e) => e.type === 'calendarChanged')).toBe(true)

  const { event, outboxId } = await engine.respondToInvite(account.id, messageId, 'accepted', 'See you there')
  expect(event.id).toBe(card.eventId!)
  await waitFor(() => states(events, outboxId!).includes('sent'))
  expect(smtp.received.length).toBe(1)
  const raw = smtp.received[0]!

  // multipart/alternative: the human text, then text/calendar; method=REPLY. No invite.ics for a reply.
  expect(contentTypes(raw)).toEqual(['multipart/alternative', 'text/plain; charset=utf-8', 'text/calendar; charset=utf-8; method=reply'])
  expect(raw).toMatch(/^Content-Type: text\/calendar; charset=UTF-8; method=REPLY/m)
  const parsed = await simpleParser(raw)
  expect(parsed.from?.value).toEqual([{ name: 'Mara Lin', address: USER.user }])
  expect(parsed.to && !Array.isArray(parsed.to) ? parsed.to.value.map((a) => a.address) : []).toEqual(['boss@example.com'])
  expect(parsed.subject).toBe('Accepted: Kickoff')
  expect(parsed.inReplyTo).toBe('<invite1@example.com>')
  expect(parsed.text).toContain('Mara Lin has accepted this invitation.')
  const ics = (await partText(raw, 'text/calendar'))!
  const reply = parseIcs(ics)
  expect(reply.method).toBe('REPLY')
  expect(reply.events).toEqual([
    expect.objectContaining({ uid: 'kickoff-123@google.com', sequence: 2, comment: 'See you there', attendees: [{ name: 'Me', email: USER.user, partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' }] }),
  ])
  expect(ics).toContain('PRODID:-//Jefi//Jefi Mail//EN')
  expect((await engine.inviteForMessage(account.id, messageId))!.response).toBe('accepted')
})

test('invitations and cancellations for our own event go to the attendees, with HTML and invite.ics', async () => {
  const { smtp, account, engine, events } = await setup()
  const event = await engine.saveEvent({
    accountId: account.id,
    title: 'Planning',
    startAt: Date.UTC(2026, 3, 2, 10),
    endAt: Date.UTC(2026, 3, 2, 11),
    timeZone: 'UTC',
    location: 'Room 4',
    attendees: [{ email: 'kenji@example.com', name: 'Kenji' }],
  })
  const sent = await engine.sendEventInvites(event.id, 'request')
  expect(sent.recipients).toEqual(['kenji@example.com'])
  await waitFor(() => states(events, sent.outboxId).includes('sent'))
  const raw = smtp.received[0]!
  expect(contentTypes(raw)).toEqual(['multipart/mixed', 'multipart/alternative', 'text/plain; charset=utf-8', 'text/html; charset=utf-8', 'text/calendar; charset=utf-8; method=request', 'application/ics; name=invite.ics'])
  const parsed = await simpleParser(raw)
  expect(parsed.subject).toBe('Invitation: Planning')
  expect(parsed.from?.value[0]!.address).toBe(USER.user)
  expect(parsed.html).toContain('<strong>Planning</strong>')
  const inline = (await partText(raw, 'text/calendar'))!
  expect(await partText(raw, 'application/ics')).toBe(inline)
  expect(parseIcs(inline).events[0]).toMatchObject({ uid: event.uid, sequence: 0, organizer: { email: USER.user, name: 'Mara Lin' }, attendees: [{ email: 'kenji@example.com', partstat: 'NEEDS-ACTION', rsvp: true }] })

  const cancel = await engine.sendEventInvites(event.id, 'cancel')
  await waitFor(() => states(events, cancel.outboxId).includes('sent'))
  const cancelled = parseIcs((await partText(smtp.received[1]!, 'text/calendar'))!)
  expect([cancelled.method, cancelled.events[0]!.sequence, cancelled.events[0]!.status]).toEqual(['CANCEL', 1, 'CANCELLED'])
  expect((await engine.getEvent(event.id))!.status).toBe('cancelled')
})

test('an answer that can’t be sent stays in the outbox and goes out, calendar and all, on retry', async () => {
  const { smtp, db, account, engine, events } = await setup()
  await smtp.close()
  const event = await engine.saveEvent({ accountId: account.id, title: 'Retro', startAt: Date.UTC(2026, 3, 3, 10), endAt: Date.UTC(2026, 3, 3, 11), attendees: [{ email: 'ada@example.com' }] })
  const { outboxId } = await engine.sendEventInvites(event.id, 'request')
  await waitFor(() => states(events, outboxId).includes('failed'))
  expect(getOutgoing(db, outboxId)).toMatchObject({ state: 'failed', permanent: false, calendar: { method: 'REQUEST', attach: true } })

  const back = await startFakeSmtp({ cert, users: [USER] })
  cleanups.push(() => back.close())
  engine.setAccounts([{ ...account, servers: { ...account.servers, smtpPort: back.port } }])
  engine.retry(account.id, outboxId)
  await waitFor(() => states(events, outboxId).includes('sent'))
  expect(back.received.length).toBe(1)
  expect(parseIcs((await partText(back.received[0]!, 'text/calendar'))!).events[0]!.uid).toBe(event.uid)
})

test('an answer held for the undo window can be taken back', async () => {
  const { smtp, db, account, engine } = await setup()
  const event = await engine.saveEvent({ accountId: account.id, title: 'Sync', startAt: Date.UTC(2026, 3, 4, 10), endAt: Date.UTC(2026, 3, 4, 11), attendees: [{ email: 'ada@example.com' }] })
  const { outboxId } = await engine.sendEventInvites(event.id, 'request', { sendAt: Date.now() + 200 })
  expect(await engine.cancelSend(account.id, outboxId)).toBe(true)
  await Bun.sleep(400)
  expect(smtp.received.length).toBe(0)
  expect(getOutgoing(db, outboxId)).toBeNull()
})
