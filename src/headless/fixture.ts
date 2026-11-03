import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDatabase } from '../engine/db'
import { createImapEngine } from '../engine/imap-engine'
import { USER, rawMessage, startImapServer } from '../engine/testing/imap-server'
import type { EngineEvent } from '../engine/types'
import { saveEvent } from '../engine/calendar/store'
import { saveNote } from '../engine/calendar/notes'
import { loadThreads } from '../engine/threads'
import { startOfDay } from '../calendar/dates'

// ---------------------------------------------------------------------------
// A Jefi config folder for the headless tests, built through the real engine: mail synced from the
// test IMAP server into mail.db, events and notes saved by the calendar store, accounts.json as the
// app writes it (with its server settings, which must never come out). Never ~/.config/jefi.
// ---------------------------------------------------------------------------

export const HOUR = 3_600_000

export async function buildFixture(options: { mcpEnabled?: boolean } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/jefi-headless-`)
  const server = await startImapServer({
    INBOX: [
      { raw: rawMessage({ n: 1, fromName: 'Ada Lovelace', fromEmail: 'ada@example.com', subject: 'Invoice for March', text: 'Please find the quarterly invoice attached.', attachment: { filename: 'inv.pdf', content: 'x' } }) },
      { raw: rawMessage({ n: 2, fromName: 'Bob', fromEmail: 'bob@example.com', subject: 'Lunch', text: 'Tacos on Friday?' }), flags: ['\\Seen'] },
      { raw: rawMessage({ n: 3, fromName: 'Nora', fromEmail: 'nora@example.com', subject: 'Planning sync', text: 'Invite for the planning sync.' }) },
    ],
  })
  const db = openDatabase(`${dir}/mail.db`)
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  engine.setAccounts([server.account])
  engine.syncNow(server.account.id, true)
  for (let i = 0; i < 250 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)
  const bodies = () => (db.query('SELECT count(*) n FROM bodies').get() as { n: number }).n
  for (let i = 0; i < 250 && bodies() < 3; i++) await Bun.sleep(20)
  engine.dispose()
  server.close()

  const accountId = server.account.id
  const threads = loadThreads(db, accountId, { bodies: true })
  const planning = threads.find((t) => t.subject === 'Planning sync')!
  const today = startOfDay(Date.now())
  saveEvent(db, { title: 'Standup', startAt: today + 9 * HOUR, endAt: today + 9.5 * HOUR, location: 'https://acme.zoom.us/j/123456?pwd=abc' })
  saveEvent(db, { title: 'Offsite', startAt: Date.UTC(new Date(today).getFullYear(), new Date(today).getMonth(), new Date(today).getDate()), endAt: Date.UTC(new Date(today).getFullYear(), new Date(today).getMonth(), new Date(today).getDate() + 1), allDay: true })
  saveEvent(db, { title: 'Gym', startAt: today + 18 * HOUR, endAt: today + 19 * HOUR, recurrence: 'FREQ=DAILY;COUNT=5', description: 'Nothing to join' })
  saveEvent(db, {
    title: 'Planning',
    startAt: today + 2 * 24 * HOUR + 14 * HOUR,
    endAt: today + 2 * 24 * HOUR + 15 * HOUR,
    accountId,
    organizer: { email: 'nora@example.com', name: 'Nora' },
    attendees: [{ email: USER.user, self: true, partstat: 'needs-action', rsvp: true }],
    description: 'Join: https://meet.google.com/abc-defg-hij',
    invite: { kind: 'message', accountId, messageId: planning.messages[0]!.id },
  })
  const note = saveNote(db, { title: 'Trip ideas', body: '# Lisbon\n\nTram 28, **pastel de nata**.', links: [{ kind: 'thread', accountId, threadId: planning.id }] })
  saveNote(db, { title: 'Groceries', body: 'Milk, eggs' })
  db.close()

  writeFileSync(`${dir}/accounts.json`, JSON.stringify({ accounts: [{ ...server.account, label: 'Work', password: 'never-shown' }], activeId: accountId }))
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ mcpEnabled: options.mcpEnabled ?? false }))
  return { dir, accountId, noteId: note.id, planningThreadId: planning.id, today, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
