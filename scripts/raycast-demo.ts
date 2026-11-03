/**
 * A demo Jefi for the Raycast extension's Store screenshots (integrations/raycast/metadata). Syncs a
 * curated mailbox from the test IMAP server into <out>/config/mail.db through the real engine, adds
 * today's events, a pending invitation and notes, and writes <out>/jefi, a stand-in for the Jefi
 * executable that runs the headless CLI against that folder. Never touches ~/.config/jefi.
 *
 *   bun scripts/raycast-demo.ts [out=tmp/raycast-demo]
 *
 * Then point the extension's "Jefi Executable" preference at <out>/jefi.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openDatabase } from '../src/engine/db'
import { createImapEngine } from '../src/engine/imap-engine'
import { USER, rawMessage, startImapServer, type TestMessage } from '../src/engine/testing/imap-server'
import type { EngineEvent } from '../src/engine/types'
import { saveEvent } from '../src/engine/calendar/store'
import { saveNote } from '../src/engine/calendar/notes'
import { loadThreads } from '../src/engine/threads'
import { startOfDay } from '../src/calendar/dates'

const out = resolve(process.argv[2] ?? 'tmp/raycast-demo')
if (!out.startsWith(`${process.cwd()}/tmp/`)) throw new Error('refusing to write the demo outside tmp/')
const dir = `${out}/config`
rmSync(out, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const now = Date.now()
const ago = (minutes: number) => new Date(now - minutes * MINUTE)
const daysAgo = (days: number, hour: number, minute = 0) => new Date(new Date(now - days * DAY).setHours(hour, minute, 0, 0))

// The same cast as scripts/shot-marketing.ts, so the Store pictures match the website's.
const MARA = 'mara@northlight.co'
const PEOPLE = {
  lea: ['Lea Ortiz', 'lea@atlas.dev'],
  kenji: ['Kenji Ito', 'kenji@northlight.co'],
  nora: ['Nora Hale', 'nora@harbor.io'],
  jules: ['Jules Park', 'jules@northlight.co'],
  mira: ['Mira Cole', 'mira@atlas.dev'],
  air: ['Coastline Air', 'trips@coastline-air.example'],
  studio: ['Fern Studio', 'hello@fernstudio.example'],
  sam: ['Sam Reyes', 'sam@harbor.io'],
} as const

type Mail = { n: number; who: keyof typeof PEOPLE; subject: string; text: string; when: Date; seen?: boolean; flagged?: boolean; attachment?: { filename: string; content: string } }

const MAIL: Mail[] = [
  { n: 1, who: 'lea', subject: 'Q3 review follow-ups', when: ago(12), text: "Thanks for the review this week. I've shared the updated deck with everyone's comments folded in. Could we do a dry run for the board on Monday at 2pm?" },
  { n: 2, who: 'kenji', subject: 'Brand workshop: logo sketches', when: ago(40), attachment: { filename: 'sketches.pdf', content: 'x' }, text: "First round of logo sketches attached. I'll bring printouts to the workshop tomorrow." },
  { n: 3, who: 'nora', subject: 'Customer feedback from this week', when: ago(95), text: 'Three themes came out of this week’s calls: setup, search and speed. Two customers mentioned how fast search feels now.' },
  { n: 4, who: 'sam', subject: 'Invoice #1042 for September', when: ago(150), attachment: { filename: 'invoice-1042.pdf', content: 'x' }, text: 'Please find the invoice for September attached. Payment terms are 30 days as usual.' },
  { n: 5, who: 'jules', subject: 'Launch checklist for Tuesday', when: ago(190), seen: true, flagged: true, text: 'Changelog is drafted, the pricing page is waiting on legal. Everything else is green.' },
  { n: 6, who: 'air', subject: 'Your trip to Lisbon is confirmed', when: ago(260), seen: true, text: 'Booking ref K7Q2LM. Flight CA 1351 departs Thursday at 7:10 AM. Check-in opens 24 hours before departure.' },
  { n: 7, who: 'kenji', subject: 'Design system updates', when: daysAgo(1, 11, 5), seen: true, text: 'Pushed the latest components and tokens to the shared library. The icon set is next.' },
  { n: 8, who: 'mira', subject: 'Team offsite in October', when: daysAgo(1, 9, 30), text: 'The team offsite is set for October 15-16 at the lake house. I’ll send the agenda next week.' },
  { n: 9, who: 'studio', subject: 'Workshop photos are ready', when: daysAgo(2, 14, 40), seen: true, text: 'Thanks for having us! The full gallery from Tuesday is ready to download.' },
  { n: 10, who: 'lea', subject: 'Analytics dashboard v2', when: daysAgo(3, 15, 10), seen: true, text: 'Sharing the latest build for your feedback. The retention view is new.' },
  { n: 11, who: 'mira', subject: 'Partnership with Atlas', when: daysAgo(4, 10, 45), seen: true, flagged: true, text: 'Would love to explore a partnership with your team next quarter.' },
  { n: 12, who: 'nora', subject: 'Invoice question from Harbor', when: daysAgo(5, 13, 20), seen: true, text: 'Their finance team asked whether the annual invoice can be split by quarter.' },
  { n: 14, who: 'lea', subject: 'Offsite agenda, first draft', when: daysAgo(1, 17, 10), seen: true, attachment: { filename: 'agenda.pdf', content: 'x' }, text: 'Rough agenda for the offsite: strategy on day one, workshops and the lake on day two.' },
  { n: 15, who: 'air', subject: 'Offsite group booking: seats held', when: daysAgo(3, 9, 15), seen: true, text: 'We are holding eight seats for your group. Please confirm names by Friday.' },
  { n: 16, who: 'studio', subject: 'Photographer for the offsite?', when: daysAgo(5, 16, 5), seen: true, text: 'Happy to join you at the lake house for a half day of team portraits.' },
  { n: 13, who: 'jules', subject: 'Offsite playlist', when: daysAgo(6, 17, 55), seen: true, text: 'Add your three songs by Friday. No skipping allowed.' },
]

const message = (m: Mail): TestMessage => ({
  raw: rawMessage({ n: m.n, subject: m.subject, text: m.text, date: m.when, attachment: m.attachment, fromName: PEOPLE[m.who][0], fromEmail: PEOPLE[m.who][1] }),
  flags: [...(m.seen ? ['\\Seen'] : []), ...(m.flagged ? ['\\Flagged'] : [])],
})

const server = await startImapServer({ INBOX: MAIL.map(message) })
const db = openDatabase(`${dir}/mail.db`)
const engine = createImapEngine({ database: () => db, secrets: { get: async () => USER.pass, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
const events: EngineEvent[] = []
engine.subscribe((batch) => events.push(...batch))
engine.setAccounts([server.account])
engine.syncNow(server.account.id, true)
for (let i = 0; i < 500 && !events.some((e) => e.type === 'syncState' && e.state.status === 'idle'); i++) await Bun.sleep(20)
const bodies = () => (db.query('SELECT count(*) n FROM bodies').get() as { n: number }).n
for (let i = 0; i < 500 && bodies() < MAIL.length; i++) await Bun.sleep(20)
engine.dispose()
server.close()

const accountId = server.account.id
const threads = loadThreads(db, accountId, { bodies: true })
const thread = (subject: string) => threads.find((t) => t.subject === subject)!

// Today: a morning that's partly behind us and an afternoon still to come, whatever the hour.
const today = startOfDay(now)
const at = (hour: number, minute = 0) => today + hour * HOUR + minute * MINUTE
const allDay = (days: number) => {
  const d = new Date(today)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + days)
}
saveEvent(db, { title: 'Standup', startAt: at(9, 30), endAt: at(9, 45), location: 'Zoom', description: 'Join: https://northlight.zoom.us/j/81234567' })
saveEvent(db, { title: 'Design review', startAt: at(11), endAt: at(12), location: 'Studio 4B' })
saveEvent(db, { title: 'Lunch with Nora', startAt: at(12, 30), endAt: at(13, 30), location: 'Harbor Café' })
saveEvent(db, { title: 'Customer call: Harbor', startAt: at(15), endAt: at(15, 45), location: 'Google Meet', description: 'Join: https://meet.google.com/hbr-cust-cll' })
saveEvent(db, { title: 'Mom’s birthday', startAt: allDay(0), endAt: allDay(1), allDay: true })

const invite = (title: string, day: number, hour: number, minutes: number, who: keyof typeof PEOPLE, subject: string) =>
  saveEvent(db, {
    title,
    startAt: today + day * DAY + hour * HOUR,
    endAt: today + day * DAY + hour * HOUR + minutes * MINUTE,
    accountId,
    organizer: { email: PEOPLE[who][1], name: PEOPLE[who][0] },
    attendees: [{ email: MARA, self: true, partstat: 'needs-action', rsvp: true }],
    invite: { kind: 'message', accountId, messageId: thread(subject).messages[0]!.id },
  })
invite('Brand workshop', 1, 15, 90, 'kenji', 'Brand workshop: logo sketches')

const note = (title: string, body: string, hoursAgo: number) => {
  const saved = saveNote(db, { title, body })
  db.run('UPDATE notes SET updated_at = ? WHERE id = ?', [now - hoursAgo * HOUR, saved.id])
}
note('Q3 review prep', 'Pricing section still needs our numbers before the board dry run.\n\n- Revenue by plan\n- Churn after the price change', 0.5)
note('Launch checklist', 'Freeze on Monday.\n\n- [x] Status page\n- [ ] Changelog\n- [ ] Pricing page', 3)
note('Onboarding ideas', 'Setup, search and speed came up in every call. Start with a two-minute import.', 26)
note('Lisbon', 'Pastéis de Belém on the first morning. Ask Mira about the ferry.', 50)
db.close()

writeFileSync(`${dir}/accounts.json`, JSON.stringify({ accounts: [{ ...server.account, name: 'Mara Lin', email: MARA, label: 'Work', password: 'never-shown' }], activeId: accountId }))
writeFileSync(`${dir}/settings.json`, JSON.stringify({ onboarded: true }))
writeFileSync(`${out}/jefi`, `#!/bin/sh\nJEFI_CONFIG_DIR='${dir}' exec '${process.execPath}' '${process.cwd()}/src/mail.tsx' "$@"\n`)
chmodSync(`${out}/jefi`, 0o755)
console.log(`${out}/jefi`)
process.exit(0)
