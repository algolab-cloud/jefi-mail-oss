/**
 * Marketing screenshots for jefi.app in both themes: the hero (mail with the app rail), the calendar
 * week with an event open, the reader's Add to calendar strip and quick add, an invitation with
 * Accept / Maybe / Decline, and a note linked to email. Curated demo mail, a realistic week and notes,
 * all in a private fixture home (never ~/.config/jefi).
 *
 * <prefix>-<shot>-<theme>.png (2400×1500).
 *
 * The first launch syncs the mail; events and notes linking to it are then written into that run's
 * mail.db, and a second launch takes the pictures. A third launch opens the menu bar item's panel
 * (<prefix>-menubar-panel-<theme>.png, the popover window with its shadow and arrow, plus
 * <prefix>-menubar-item-<theme>.png, the item's button), after a meeting has been put 25 minutes out
 * and a message and an invitation have arrived while it runs. That launch puts a real, temporary item
 * on this Mac's menu bar.
 *
 *   bun scripts/shot-marketing.ts [prefix] [--menubar-only] [--theme=dark|light] [--accent=violet] [--glass]
 *
 * --glass takes the window shots in Liquid Glass: GPUIX's own screenshots flatten the window onto black,
 * so the app runs in front over a wallpaper window (scripts/native/wallpaper-window.swift) and each shot
 * is captured from the screen, native traffic lights and all. It takes over the screen while it runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { WEBSITE } from './website-dir'
import { buildLifecycleHelper } from './native/build-lifecycle'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { rawMessage, type TestMessage } from '../src/engine/testing/imap-server'
import { DEFAULT_SETTINGS, type AccentName } from '../src/theme'
import { APP_VERSION } from '../src/version'
import { openDatabase } from '../src/engine/db'
import { createImapEngine } from '../src/engine/imap-engine'
import { uiThreadId } from '../src/engine/threading'
import { saveNote } from '../src/engine/calendar/notes'
import { addDays, firstDayOfWeek, startOfWeek } from '../src/calendar/dates'
import type { EventInput } from '../src/engine'

const args = process.argv.slice(2)
// --menubar-only skips the window shots (the mailbox is still synced and seeded first).
const menubarOnly = args.includes('--menubar-only')
const glass = args.includes('--glass')
const out = args.find((a) => !a.startsWith('--')) ?? `${process.cwd()}/tmp/marketing`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const now = Date.now()

// ---------------------------------------------------------------------------
// The mailbox
// ---------------------------------------------------------------------------

const PEOPLE = {
  lea: ['Lea Ortiz', 'lea@atlas.dev'],
  kenji: ['Kenji Ito', 'kenji@northlight.co'],
  nora: ['Nora Hale', 'nora@harbor.io'],
  jules: ['Jules Park', 'jules@northlight.co'],
  mira: ['Mira Cole', 'mira@atlas.dev'],
  air: ['Coastline Air', 'trips@coastline-air.example'],
  studio: ['Fern Studio', 'hello@fernstudio.example'],
} as const

/** Today's mail sits minutes before now; older mail at a sensible hour some days back. */
const ago = (minutes: number) => new Date(now - minutes * MINUTE)
const daysAgo = (days: number, hour: number, minute = 0) => new Date(new Date(now - days * DAY).setHours(hour, minute, 0, 0))

// Wall-clock stamps in the Mac's own zone, so the card shows one time rather than two.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const pad = (n: number) => String(n).padStart(2, '0')
const local = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
}
const ics = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
type Invite = { uid: string; from: readonly [string, string]; summary: string; start: number; minutes: number; location: string; description: string; body: string; sent: Date; others: Array<[string, string, string]> }

/** An invitation to Mara as a real iMIP REQUEST, the way Google or Outlook would send it. */
const inviteRaw = (i: Invite) => {
  const cal = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Northlight//Calendar//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${i.uid}`,
    'SEQUENCE:0',
    `DTSTAMP:${ics(i.sent.getTime())}`,
    `DTSTART;TZID=${zone}:${local(i.start)}`,
    `DTEND;TZID=${zone}:${local(i.start + i.minutes * MINUTE)}`,
    `SUMMARY:${i.summary}`,
    `LOCATION:${i.location.replace(/,/g, '\\,')}`,
    `DESCRIPTION:${i.description}`,
    `ORGANIZER;CN=${i.from[0]}:mailto:${i.from[1]}`,
    `ATTENDEE;CN=${i.from[0]};PARTSTAT=ACCEPTED:mailto:${i.from[1]}`,
    'ATTENDEE;CN=Mara Lin;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.com',
    ...i.others.map(([name, email, partstat]) => `ATTENDEE;CN=${name};PARTSTAT=${partstat}:mailto:${email}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  return [
    `From: ${i.from[0]} <${i.from[1]}>`,
    'To: Mara Lin <me@example.com>',
    `Subject: Invitation: ${i.summary}`,
    `Message-ID: <${i.uid}>`,
    `Date: ${i.sent.toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    '',
    i.body,
    '--alt',
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
    '',
    cal,
    '--alt--',
    '',
  ].join('\r\n')
}

const inviteMessage = (): TestMessage => ({
  raw: inviteRaw({
    uid: 'brand-workshop-2026@northlight.co',
    from: PEOPLE.kenji,
    summary: 'Brand workshop',
    start: new Date(now + DAY).setHours(15, 0, 0, 0),
    minutes: 90,
    location: 'Northlight studio, 4th floor',
    description: "Bring two logos you love and one you don't.",
    body: "Hi Mara,\n\nCould we spend an afternoon on the new brand? I'll bring the first round of logo sketches.\n\nKenji",
    sent: ago(40),
    others: [['Lea Ortiz', 'lea@atlas.dev', 'ACCEPTED'], ['Jules Park', 'jules@northlight.co', 'TENTATIVE']],
  }),
  flags: [],
  'X-GM-MSGID': '9100',
})

type Mail = { n: number; who: keyof typeof PEOPLE; subject: string; text: string; when: Date; seen?: boolean; flagged?: boolean; labels?: string[]; attachment?: { filename: string; content: string }; messageId?: string; inReplyTo?: string }

const MAIL: Mail[] = [
  {
    n: 1, who: 'lea', subject: 'Q3 review follow-ups', when: ago(12), labels: ['Product'],
    text: "Hi Mara,\n\nThanks for the review this week. I've shared the updated deck with everyone's comments folded in. Could we do a dry run for the board on Monday at 2pm? An hour should be plenty.\n\nThe pricing section still needs your numbers, and I'd love a second pair of eyes on the churn chart.\n\nThanks!\nLea",
  },
  { n: 3, who: 'nora', subject: 'Customer feedback', when: daysAgo(1, 16, 20), seen: true, labels: ['Customers'], messageId: '<feedback-1@harbor.io>', text: 'Three themes came out of this week’s calls: setup, search and speed..' },
  { n: 4, who: 'nora', subject: 'Re: Customer feedback', when: ago(95), messageId: '<feedback-2@harbor.io>', inReplyTo: '<feedback-1@harbor.io>', text: 'Following up with two more calls from this morning. Both mentioned how fast search feels now.' },
  { n: 5, who: 'jules', subject: 'Launch checklist for Tuesday', when: ago(130), seen: true, flagged: true, text: 'Changelog is drafted, the pricing page is waiting on legal. Everything else is green.' },
  { n: 6, who: 'air', subject: 'Your trip to Lisbon is confirmed', when: ago(170), seen: true, text: 'Booking ref K7Q2LM. Flight CA 1351 departs Thursday at 7:10 AM. Check-in opens 24 hours before departure.' },
  { n: 7, who: 'kenji', subject: 'Design system updates', when: daysAgo(1, 11, 5), seen: true, labels: ['Design'], text: 'Pushed the latest components and tokens to the shared library. The icon set is next.' },
  {
    n: 8, who: 'mira', subject: 'Team offsite', when: daysAgo(1, 9, 30), seen: true,
    text: 'Hi all,\n\nThe team offsite is set for October 15-16 at the lake house. I’ll send the agenda next week.\n\nMira',
  },
  { n: 9, who: 'studio', subject: 'Workshop photos are ready', when: daysAgo(2, 14, 40), seen: true, text: 'Thanks for having us! The full gallery from Tuesday is ready to download.' },
  { n: 10, who: 'lea', subject: 'Analytics dashboard v2', when: daysAgo(3, 15, 10), seen: true, text: 'Sharing the latest build for your feedback. The retention view is new.' },
  { n: 11, who: 'mira', subject: 'Partnership with Atlas', when: daysAgo(4, 10, 45), seen: true, flagged: true, text: 'Would love to explore a partnership with your team next quarter.' },
  { n: 12, who: 'jules', subject: 'Offsite playlist', when: daysAgo(6, 17, 55), seen: true, text: 'Add your three songs by Friday. No skipping allowed.' },
]

const message = (m: Mail): TestMessage => ({
  raw: rawMessage({ n: m.n, subject: m.subject, text: m.text, date: m.when, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.inReplyTo ? [m.inReplyTo] : undefined, attachment: m.attachment, fromName: PEOPLE[m.who][0], fromEmail: PEOPLE[m.who][1] }),
  flags: [...(m.seen ? ['\\Seen'] : []), ...(m.flagged ? ['\\Flagged'] : [])],
  'X-GM-MSGID': String(9000 + m.n),
  'X-GM-LABELS': m.labels,
})

const INBOX = [...MAIL.map(message), inviteMessage()]

// ---------------------------------------------------------------------------
// The week and the notes, seeded after the first sync so they can link to the mail
// ---------------------------------------------------------------------------

const week = startOfWeek(now, firstDayOfWeek())
const at = (day: number, hour: number, minute = 0) => new Date(addDays(week, day)).setHours(hour, minute, 0, 0)
const dayOf = (day: number) => {
  const d = new Date(addDays(week, day))
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

async function seed(dbPath: string, accountId: string) {
  const db = openDatabase(dbPath)
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, watch: false, wake: false })
  const thread = (subject: string) => {
    const row = db.query('SELECT id, thread_id FROM messages WHERE account_id = ? AND subject = ? ORDER BY id LIMIT 1').get(accountId, subject) as { id: number; thread_id: string | null } | null
    if (!row) throw new Error(`no "${subject}" in the synced mail`)
    const threadId = uiThreadId(accountId, row.thread_id, row.id)
    return { threadId, messageId: `${threadId}-${row.id}` }
  }

  const [personal] = await engine.listCalendars()
  await engine.updateCalendar(personal!.id, { color: '#12A594' })
  const work = await engine.createLocalCalendar({ name: 'Work', color: '#3E63DD' })
  const travel = await engine.createLocalCalendar({ name: 'Travel', color: '#F76B15' })
  const family = await engine.createLocalCalendar({ name: 'Family', color: '#D6409F' })
  await engine.updateCalendar(work.id, { isDefault: true })

  const timed = (calendarId: string, title: string, day: number, from: [number, number?], to: [number, number?], extra: Partial<EventInput> = {}) =>
    engine.saveEvent({ calendarId, title, startAt: at(day, ...from), endAt: at(day, ...to), ...extra })
  const allDay = (calendarId: string, title: string, day: number, days = 1, extra: Partial<EventInput> = {}) =>
    engine.saveEvent({ calendarId, title, allDay: true, startAt: dayOf(day), endAt: dayOf(day + days), ...extra })

  await engine.saveEvent({ calendarId: work.id, title: 'Standup', startAt: at(-20, 9, 30), endAt: at(-20, 9, 45), recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', location: 'Zoom' })
  const people = [
    { email: 'lea@atlas.dev', name: 'Lea Ortiz', partstat: 'accepted' as const },
    { email: 'kenji@northlight.co', name: 'Kenji Ito', partstat: 'tentative' as const },
    { email: 'nora@harbor.io', name: 'Nora Hale', partstat: 'needs-action' as const },
  ]
  await timed(personal!.id, 'Run by the river', 0, [8], [9])
  await timed(work.id, 'Design review', 1, [11], [12], { location: 'Studio 4B', attendees: people.slice(0, 2) })
  await timed(work.id, 'Customer call: Harbor', 1, [11, 30], [12, 30], { location: 'Google Meet' })
  await timed(work.id, 'Focus: pricing model', 1, [14], [16, 30])
  await timed(personal!.id, 'Lunch with Nora', 2, [12, 30], [13, 30], { location: 'Harbor Café' })
  await timed(work.id, 'Hiring sync', 2, [15], [15, 45])
  const review = await timed(work.id, 'Q3 product review', 3, [10], [11, 30], {
    location: 'Boardroom',
    attendees: people,
    description: 'Walk through the deck, then agree pricing for Q4. Lea is bringing the numbers.',
  })
  await timed(work.id, 'Roadmap sync', 3, [14], [15])
  await timed(family.id, 'School pickup', 3, [16, 30], [17])
  await allDay(travel.id, 'Offsite · Lisbon', 4, 2, { location: 'Lisbon' })
  await timed(travel.id, 'Flight CA 1351', 4, [7, 10], [9, 45], { location: 'LHR → LIS' })
  await timed(work.id, 'Interview: senior designer', 4, [14], [15, 30], { attendees: people.slice(1) })
  await timed(work.id, 'Launch retro', 5, [16], [17])
  await timed(personal!.id, 'Yoga', 6, [8], [9])
  await timed(family.id, 'Dinner with Mira', 6, [19, 30], [22])
  await allDay(family.id, 'Mom’s birthday', 2, 1)

  const q3 = thread('Q3 review follow-ups')
  await engine.linkEvent(review.id, { kind: 'thread', accountId, threadId: q3.threadId })

  const feedback = thread('Customer feedback')
  const launchPlan = thread('Launch checklist for Tuesday')
  const note = (input: Parameters<typeof saveNote>[1], hoursAgo: number) => {
    const saved = saveNote(db, input)
    db.run('UPDATE notes SET updated_at = ?, created_at = ? WHERE id = ?', [now - hoursAgo * HOUR, now - (hoursAgo + 30) * HOUR, saved.id])
    return saved
  }
  note(
    {
      title: 'Q3 review prep',
      pinned: true,
      body: [
        "Lea's deck is in good shape. The pricing section still needs our numbers before the board dry run.",
        '',
        '> The pricing section still needs your numbers.',
        '>',
        '> — Lea Ortiz',
        '',
        '## To bring',
        '- Revenue by plan, **July–September**',
        '- Churn after the price change',
        '- Three customer quotes from Nora’s calls',
        '',
        '## Open questions',
        '- Do we keep the annual discount at 20%?',
        '- Who presents the roadmap slide?',
      ].join('\n'),
      links: [
        { kind: 'thread', accountId, threadId: q3.threadId },
        { kind: 'message', accountId, messageId: feedback.messageId },
        { kind: 'event', eventId: review.id },
      ],
    },
    0.3,
  )
  note({ title: 'Launch checklist', body: 'Freeze on Monday.\n\n- [x] Status page\n- [ ] Changelog\n- [ ] Pricing page', links: [{ kind: 'thread', accountId, threadId: launchPlan.threadId }] }, 3)
  note({ title: 'Onboarding ideas', body: 'Setup, search and speed came up in every call.\nStart with a two-minute import.' }, 26)
  note({ title: 'Lisbon', body: 'Pastéis de Belém on the first morning. Ask Mira about the ferry.' }, 50)
  note({ title: 'Reading list', body: '- Shape Up\n- The Mom Test\n- Working in Public' }, 24 * 9)

  engine.dispose()
  db.close()
}

/** For the menu bar: the next meeting 25 minutes out and a little more later today. */
async function seedToday(dbPath: string) {
  const db = openDatabase(dbPath)
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, watch: false, wake: false })
  const calendars = await engine.listCalendars()
  const work = calendars.find((c) => c.name === 'Work')!
  // On a round five minutes, 25 to 30 minutes out once the panel opens.
  const soon = Math.ceil((Date.now() + 26 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE
  await engine.saveEvent({ calendarId: work.id, title: NEXT_TITLE, startAt: soon, endAt: soon + 30 * MINUTE, location: 'Zoom' })
  await engine.saveEvent({ calendarId: work.id, title: 'Call with Kenji', startAt: soon + 2 * HOUR, endAt: soon + 2.5 * HOUR, location: 'Google Meet' })
  engine.dispose()
  db.close()
}
const NEXT_TITLE = 'Design crit'

// ---------------------------------------------------------------------------
// The pictures
// ---------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof launch>>

// sharp is a dependency of the website, not the app; SHARP_DIR points at another install of it.
const sharpDir = process.env.SHARP_DIR ?? `${WEBSITE}/node_modules/sharp`
const { default: sharp } = (await import(`${sharpDir}/dist/index.mjs`)) as { default: (input: string | Buffer) => any }

/** The menu bar shot's wallpaper: a soft abstract gradient in Jefi's violet and indigo, at the screen's pixel size. */
function wallpaperSvg(theme: 'dark' | 'light', w: number, h: number) {
  const dark = theme === 'dark'
  const base = dark ? ['#0d0b24', '#1a1240', '#0b1330'] : ['#efeaff', '#f7eef8', '#e6eefc']
  const blobs: Array<[number, number, number, string, number]> = dark
    ? [[0.72, 0.18, 0.55, '#6d4cff', 0.85], [0.35, 0.55, 0.5, '#3a52e0', 0.7], [0.9, 0.7, 0.45, '#c24bd1', 0.6], [0.15, 0.15, 0.4, '#8a3ffc', 0.45]]
    : [[0.72, 0.18, 0.55, '#a48dff', 0.8], [0.35, 0.55, 0.5, '#8fb0ff', 0.7], [0.9, 0.7, 0.45, '#f5a3d9', 0.65], [0.15, 0.15, 0.4, '#c7b6ff', 0.6]]
  const defs = blobs.map(([, , , c, o], i) => `<radialGradient id="b${i}"><stop offset="0" stop-color="${c}" stop-opacity="${o}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('')
  const circles = blobs.map(([x, y, r], i) => `<ellipse cx="${x * w}" cy="${y * h}" rx="${r * w}" ry="${r * w * 0.8}" fill="url(#b${i})"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${base[0]}"/><stop offset=".55" stop-color="${base[1]}"/><stop offset="1" stop-color="${base[2]}"/></linearGradient>${defs}</defs><rect width="100%" height="100%" fill="url(#g)"/>${circles}</svg>`
}

/**
 * The app's window as it sits on the screen. Capturing the window alone (-l) draws its glass over
 * nothing, so the screen region under it is captured instead, where the blur of the wallpaper is real.
 */
async function glassShot(path: string) {
  const [id, x, y, w, h] = Bun.spawnSync(['swift', `${import.meta.dir}/native/window-number.swift`, 'Jefi Mail', 'bun']).stdout.toString().trim().split(' ')
  if (!id || !h) throw new Error('could not find the app window on screen')
  writeFileSync(wallpaperTarget, id)
  await wait(700)
  Bun.spawnSync(['screencapture', '-x', `-R${x},${y},${w},${h}`, path])
}
const wallpaperTarget = `${process.cwd()}/tmp/glass-wallpaper-target`

mkdirSync(`${process.cwd()}/tmp`, { recursive: true })
const helper = `${process.cwd()}/tmp/libJefiLifecycle.dylib`
buildLifecycleHelper(helper)

const only = args.find((a) => a.startsWith('--theme='))?.slice(8)
// --accent overrides each theme's accent (the tweet images use the brand violet).
const accentArg = args.find((a) => a.startsWith('--accent='))?.slice(9) as AccentName | undefined
for (const [theme, themeAccent] of ([['light', 'blue'], ['dark', 'violet']] as const).filter(([t]) => !only || t === only)) {
  const accent = accentArg ?? themeAccent
  const home = `${process.cwd()}/tmp/marketing-home-${theme}`
  const fixture = await startFixture(home, { inbox: INBOX })
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir?.startsWith(`${process.cwd()}/tmp/`)) throw new Error('refusing to seed outside the temporary fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: glass ? 'glass' : 'default', theme, accent, onboarded: true, lastSeenVersion: APP_VERSION }))
  const start = () =>
    launch({
      command: 'sh',
      args: ['-c', `exec bun src/mail.tsx 2>>'${out}-app.log'`],
      // Glass shots come off the screen, so the window has to be up front rather than in the background.
      env: { ...(glass ? {} : { GPUIX_BACKGROUND: '1' }), JEFI_SKIP_ONBOARDING: '1', JEFI_WINDOW: '1200x750', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, ...fixture.env },
      cwd: process.cwd(),
    })
  const helpers = (app: App) => {
    const has = async (testId: string) => (await app.getByTestId(testId).count().catch(() => 0)) > 0
    const hasText = async (text: string) => (await app.getByText(text).all().catch(() => [])).length > 0
    const until = async (what: () => Promise<boolean>, label: string) => {
      for (let i = 0; !(await what()); i++) {
        if (i > 100) throw new Error(`timed out waiting for ${label}`)
        await wait(200)
      }
    }
    const click = async (testId: string) => {
      for (let i = 0; ; i++) {
        try {
          return await app.getByTestId(testId).click()
        } catch (err) {
          if (i >= 25) throw new Error(`could not click ${testId}: ${err}`)
          await wait(200)
        }
      }
    }
    const clickText = async (text: string) => {
      await until(() => hasText(text), text)
      const [node] = await app.getByText(text).all()
      const b = node!.bounds!
      await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    }
    /** Clicks until `target` shows: the first clicks after launch can be lost. */
    const reach = async (testId: string, target: string) => {
      for (let i = 0; !(await has(target)); i++) {
        if (i > 20) throw new Error(`${target} never appeared after clicking ${testId}`)
        await click(testId)
        await wait(500)
      }
    }
    const shot = async (name: string) => {
      await app.mouse.move({ x: 1190, y: 740 }).catch(() => {})
      await wait(900)
      if (glass) await glassShot(`${out}-${name}-${theme}.png`)
      else await app.screenshot({ path: `${out}-${name}-${theme}.png` })
    }
    return { has, hasText, until, click, clickText, reach, shot }
  }

  try {
    let app = await start()
    try {
      await helpers(app).until(() => helpers(app).hasText('Q3 review follow-ups'), 'the first sync')
      await wait(1500)
    } finally {
      await app.close()
    }
    await seed(`${dir}/mail.db`, fixture.account.id)

    if (!menubarOnly) {
      // Glass needs something to blur: the brand wallpaper, held right behind the app's window.
      let wallpaper: ReturnType<typeof Bun.spawn> | null = null
      if (glass) {
        const image = `${out}-glass-wallpaper-${theme}.png`
        await sharp(Buffer.from(wallpaperSvg(theme, 3456, 2234))).png().toFile(image)
        writeFileSync(wallpaperTarget, '')
        wallpaper = Bun.spawn(['swift', `${import.meta.dir}/native/wallpaper-window.swift`, image, wallpaperTarget], { stdout: 'ignore', stderr: 'inherit' })
        await wait(4000)
      }
      app = await start()
      const { until, hasText, click, clickText, reach, shot } = helpers(app)
      try {
        await until(() => hasText('Q3 review follow-ups'), 'the mailbox')
        // Let the inbox badge's sync spinner settle.
        await wait(4000)

        // Hero: the inbox with the newest message open and its date ready to add.
        await clickText('Q3 review follow-ups')
        await until(() => hasText('Add to calendar'), 'the date suggestion')
        await shot('hero')

        for (let i = 0; (await app.getByTestId('quick-add').all().catch(() => [])).length === 0; i++) {
          if (i > 10) throw new Error('quick add never opened')
          await clickText('Add to calendar')
          await wait(400)
        }
        await app.getByTestId('quick-add-title').fill('Board dry run with Lea')
        await shot('quick-add')
        await app.keyboard?.press?.('Escape')
        await wait(300)

        await clickText('Invitation: Brand workshop')
        await until(async () => (await app.getByTestId('invite-card').count()) > 0, 'the invite card')
        await shot('invite')

        await reach('nav-calendar', 'calendar-pane')
        await shot('week')
        await click('event-Q3 product review')
        await shot('event')
        await click('event-card-close')

        // A note opens rendered, ready to read.
        await reach('nav-notes', 'note-links')
        await shot('notes')
      } catch (error) {
        await app.screenshot({ path: `${out}-error-${theme}.png` }).catch(() => {})
        throw error
      } finally {
        await app.close()
        wallpaper?.kill()
      }
      // The menu bar scene isn't a glass shot; a glass run stops after the window shots.
      if (glass) continue
    }

    // The menu bar panel, on a third launch with the item on and a meeting coming up.
    await seedToday(`${dir}/mail.db`)
    writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded: true, lastSeenVersion: APP_VERSION, menuBar: true, menuBarTitle: 'next' }))
    const log = `${out}-menubar-${theme}.log`
    const commandFile = `${home}/menubar-command`
    writeFileSync(log, '')
    app = await launch({
      command: 'sh',
      args: ['-c', `exec bun src/mail.tsx 2>>'${log}'`],
      env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_WINDOW: '1200x750', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, JEFI_MENUBAR_DEBUG: commandFile, JEFI_LIFECYCLE_HELPER: helper, ...fixture.env },
      cwd: process.cwd(),
    })
    const { until: untilBar, hasText: hasBarText } = helpers(app)
    try {
      let pid = 0
      await untilBar(async () => (pid = Number(readFileSync(log, 'utf8').match(/\[menubar\] ready pid=(\d+)/)?.[1] ?? 0)) > 0, 'the menu bar item')
      /** One debug command (src/menubar/debug.ts); returns the fields of its answer. */
      const command = async (text: string) => {
        const seen = readFileSync(log, 'utf8').length
        writeFileSync(commandFile, text)
        process.kill(pid, 'SIGUSR1')
        // Opening the panel on a second display can take a few seconds.
        for (let i = 0; i < 150; i++) {
          await wait(100)
          const line = readFileSync(log, 'utf8').slice(seen).split('\n').find((l) => l.startsWith(`[menubar] ${text.split(' ')[0]} `))
          if (line) return Object.fromEntries(line.split(' ').slice(2).map((pair) => pair.split('='))) as Record<string, string>
        }
        throw new Error(`no answer to ${text}`)
      }
      await untilBar(() => hasBarText('Q3 review follow-ups'), 'the mailbox')
      await wait(2500)
      // Arrivals while running, so Recent has a message and an invitation in it.
      await fixture.imap.append('INBOX', {
        raw: inviteRaw({
          uid: `offsite-dinner-${now}@atlas.dev`,
          from: PEOPLE.mira,
          summary: 'Offsite dinner',
          start: new Date(now + 3 * DAY).setHours(19, 30, 0, 0),
          minutes: 120,
          location: 'Taberna da Rua',
          description: 'Table for eight. Dress code: whatever you flew in.',
          body: 'Booked the place with the tiles. See you there!\n\nMira',
          sent: new Date(),
          others: [['Lea Ortiz', 'lea@atlas.dev', 'ACCEPTED']],
        }),
      })
      await wait(1500)
      await fixture.deliver('Pricing page numbers', 'Legal signed off. Can you drop the final numbers in before 3?', { name: PEOPLE.lea[0], email: PEOPLE.lea[1] })
      await untilBar(() => hasBarText('Pricing page numbers'), 'the new message')
      await wait(2000)
      // The glass is shot in place: the wallpaper goes up as a real window behind the popover (the
      // desktop's own is left alone), the popover's appearance is pinned to the theme, and the
      // screen region around it is captured. marketing-images.ts draws the menu bar above.
      const closePanel = async () => {
        for (let i = 0; i < 3 && (await command('state')).panel === '1'; i++) await command('click')
      }
      const nums = (field?: string) => (field ?? '').split(',').filter(Boolean).map(Number)
      /** Opens the panel on a Retina screen: with two displays it can open on a 1x one; try again, then give up loudly. */
      const openOnRetina = async () => {
        for (let attempt = 1; attempt <= 8; attempt++) {
          await closePanel()
          await command('click')
          await wait(1200)
          const state = await command('state')
          if (state.panel === '1' && nums(state.screen)[4] === 2) return state
          await wait(1000)
        }
        throw new Error('the panel keeps opening on a 1x display; move the pointer to the Retina screen')
      }
      const wallpaperPng = `${out}-menubar-wallpaper-${theme}.png`
      const regionPng = `${out}-menubar-region-${theme}.png`
      try {
        await command(`appearance ${theme}`)
        const [sx, sy, sw, sh] = nums((await openOnRetina()).screen)
        await closePanel()
        await sharp(Buffer.from(wallpaperSvg(theme, sw! * 2, sh! * 2))).png().toFile(wallpaperPng)
        await command(`backdrop image ${wallpaperPng}`)
        await wait(500)
        const shown = await openOnRetina()
        // The item's button drawn on its own (it can sit under the notch), now at Retina scale.
        await command(`item-png ${out}-menubar-item-${theme}.tiff`)
        Bun.spawnSync(['sips', '-s', 'format', 'png', `${out}-menubar-item-${theme}.tiff`, '--out', `${out}-menubar-item-${theme}.png`], { stdout: 'ignore' })
        await wait(800)
        const [fx, fy, fw, fh] = nums(shown.frame)
        const [ix, iy, iw, ih] = nums(shown.item)
        const screen = nums(shown.screen)
        if (!(fw! > 0) || screen[0] !== sx || screen[1] !== sy) throw new Error('the panel moved to another screen between shots')
        // 720 points wide around the item, from the top of the screen (the wallpaper window covers the
        // real menu bar, and the panel's arrow reaches into it) to under the panel's shadow.
        const width = 720
        const left = Math.min(Math.max(ix! + iw! / 2 - width / 2, sx!), sx! + sw! - width)
        const top = sy!
        const height = Math.min(fy! + fh! + 40, sy! + sh!) - top
        Bun.spawnSync(['screencapture', '-x', '-R', `${left},${top},${width},${height}`, regionPng])
        writeFileSync(`${out}-menubar-${theme}.json`, JSON.stringify({ wallpaper: wallpaperPng, region: regionPng, scale: 2, left: left - sx!, bar: iy! + ih! - sy!, width, height, item: { x: ix! - sx!, y: iy! - sy!, width: iw, height: ih }, panel: { x: fx! - sx!, y: fy! - sy!, width: fw, height: fh } }))
        await closePanel()
      } finally {
        await command('appearance system')
        await command('backdrop none')
      }
    } catch (error) {
      await app.screenshot({ path: `${out}-error-menubar-${theme}.png` }).catch(() => {})
      throw error
    } finally {
      await app.close()
    }
  } finally {
    await fixture.close()
  }
}
console.log('saved', out)
process.exit(0)
