/**
 * Screenshots of the calendar in both themes: week, day, month, agenda, an event's card and the
 * editor, against the in-memory fixture mailbox with a realistic week seeded through the engine.
 *
 *   bun scripts/shot-calendar.ts [prefix]   → <prefix>-<view>-<theme>.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { openDatabase } from '../src/engine/db'
import { createImapEngine } from '../src/engine/imap-engine'
import { uiThreadId } from '../src/engine/threading'
import { addDays, firstDayOfWeek, startOfWeek } from '../src/calendar/dates'
import type { EventInput } from '../src/engine'

const out = process.argv[2] ?? `${process.cwd()}/tmp/calendar`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HOUR = 3_600_000

/** A local wall-clock time on a day of the week on screen (0 = its first day). */
const week = startOfWeek(Date.now(), firstDayOfWeek())
const at = (day: number, hour: number, minute = 0) => new Date(addDays(week, day)).setHours(hour, minute, 0, 0)
const dayOf = (day: number) => {
  const d = new Date(addDays(week, day))
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Calendars and a realistic week of events, straight into the fixture's mail.db through the engine. */
async function seed(dbPath: string) {
  const db = openDatabase(dbPath)
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, watch: false, wake: false })
  const [personal] = await engine.listCalendars()
  await engine.updateCalendar(personal!.id, { color: '#12A594' })
  const work = await engine.createLocalCalendar({ name: 'Work', color: '#3E63DD' })
  const travel = await engine.createLocalCalendar({ name: 'Travel', color: '#F76B15' })
  const family = await engine.createLocalCalendar({ name: 'Family', color: '#D6409F' })
  await engine.createLocalCalendar({ name: 'Holidays', color: '#8E4EC6' }).then((c) => engine.updateCalendar(c.id, { hidden: true }))
  await engine.updateCalendar(work.id, { isDefault: true })

  const timed = (calendarId: string, title: string, day: number, from: [number, number?], to: [number, number?], extra: Partial<EventInput> = {}) =>
    engine.saveEvent({ calendarId, title, startAt: at(day, ...from), endAt: at(day, ...to), ...extra })
  const allDay = (calendarId: string, title: string, day: number, days = 1, extra: Partial<EventInput> = {}) =>
    engine.saveEvent({ calendarId, title, allDay: true, startAt: dayOf(day), endAt: dayOf(day + days), ...extra })

  // Weekday standup since three weeks ago.
  await engine.saveEvent({ calendarId: work.id, title: 'Standup', startAt: at(-20, 9, 30), endAt: at(-20, 9, 45), recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', location: 'Zoom' })

  const people = [
    { email: 'lea@atlas.dev', name: 'Lea Ortiz', partstat: 'accepted' as const },
    { email: 'kenji@northlight.co', name: 'Kenji Ito', partstat: 'tentative' as const },
    { email: 'nora@harbor.io', name: 'Nora Hale', partstat: 'needs-action' as const },
  ]
  // Three at once on day 1.
  await timed(work.id, 'Design review', 1, [11], [12], { location: 'Studio 4B', attendees: people.slice(0, 2) })
  await timed(work.id, 'Customer call: Northwind', 1, [11, 30], [12, 30], { location: 'Google Meet' })
  await timed(personal!.id, '1:1 with Kenji', 1, [11], [11, 30])
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
  await timed(work.id, 'Interview: Senior designer', 4, [14], [15, 30], { attendees: people.slice(1) })
  await timed(travel.id, 'Flight TP 1351', 4, [7, 10], [9, 45], { location: 'LHR → LIS' })
  await timed(work.id, 'Launch retro', 5, [16], [17])
  await timed(personal!.id, 'Yoga', 6, [8], [9])
  await timed(family.id, 'Dinner with Mira', 6, [19, 30], [22])
  await allDay(family.id, 'Mom’s birthday', 0, 1, { recurrence: 'FREQ=YEARLY' })
  await timed(personal!.id, 'Run', 0, [8], [9])
  // Next week, for the agenda and the month.
  await timed(work.id, 'Quarterly planning', 8, [9], [12], { location: 'Boardroom' })
  await timed(personal!.id, 'Dentist', 9, [8, 30], [9, 15], { location: 'Smile Clinic' })
  await timed(work.id, 'Board prep', 10, [13], [14, 30])
  await allDay(personal!.id, 'Bank holiday', 12)
  await timed(family.id, 'Piano recital', 13, [18], [19, 30], { location: 'Town hall' })
  await timed(work.id, 'Vendor demo', 15, [11], [12])
  // A busy day for "+N more".
  for (const [title, h] of [['Coffee with Jules', 8], ['Security review', 10], ['Budget check-in', 12], ['Team photo', 13], ['Office hours', 15], ['Drinks', 18]] as const) {
    await timed(work.id, title, 16, [h], [h + 1])
  }
  await allDay(travel.id, 'Berlin trip', 18, 3)
  await timed(work.id, 'Last week’s demo', -5, [15], [16])
  await timed(personal!.id, 'Haircut', -3, [11], [11, 45])

  engine.dispose()
  return { db, reviewId: review.id }
}

for (const [theme, accent] of [['dark', 'violet'], ['light', 'blue']] as const) {
  const home = `${process.cwd()}/tmp/calendar-home-${theme}`
  const fixture = await startFixture(home)
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir?.startsWith(process.cwd())) throw new Error('refusing to seed outside the temporary fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded: true, lastSeenVersion: '99.0.0' }))
  const { db, reviewId } = await seed(`${dir}/mail.db`)
  const app = await launch({
    // The app's stderr goes to a log, so a render error doesn't vanish with the pipe.
    command: 'sh',
    args: ['-c', `exec bun src/mail.tsx 2>>'${out}-app.log'`],
    env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, ...fixture.env },
    cwd: process.cwd(),
  })
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
  const shot = async (name: string) => {
    await wait(700)
    await app.screenshot({ path: `${out}-${name}-${theme}.png` })
  }
  try {
    for (let i = 0; (await app.getByText('Q3 product review').all().catch(() => [])).length === 0; i++) {
      if (i > 100) throw new Error('mail never synced')
      await wait(200)
    }
    // Link the review to its email now that the mail is in the database.
    const row = db.query("SELECT id, account_id, thread_id FROM messages WHERE subject = 'Q3 product review' LIMIT 1").get() as { id: number; account_id: string; thread_id: string | null }
    const linker = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, watch: false, wake: false })
    await linker.linkEvent(reviewId, { kind: 'thread', accountId: row.account_id, threadId: uiThreadId(row.account_id, row.thread_id, row.id) })
    linker.dispose()

    // A click in the first moments after sync can be lost; keep asking until the calendar is up.
    for (let i = 0; (await app.getByTestId('calendar-pane').count()) === 0; i++) {
      if (i > 20) throw new Error('the calendar never opened')
      await click('nav-calendar')
      await wait(500)
    }
    await shot('week')
    await click('event-Q3 product review')
    await shot('popover')
    await click('event-card-close')
    await click('calendar-view-day')
    await shot('day')
    await click('calendar-view-month')
    await shot('month')
    await click('event-Dinner with Mira')
    await shot('month-popover')
    await click('event-card-close')
    await click('calendar-view-agenda')
    await shot('agenda')
    await click('calendar-view-week')
    await click('calendar-new')
    await wait(300)
    await app.getByTestId('event-title').fill('Coffee with Lea')
    await app.getByTestId('event-location').fill('Blue Bottle, Market St')
    await app.getByTestId('event-guests').fill('lea@atlas.dev ')
    await shot('editor')
    await click('event-save')
    for (let i = 0; (await app.getByTestId('event-Coffee with Lea').count()) === 0; i++) {
      if (i > 25) throw new Error('the saved event never appeared')
      await wait(200)
    }
    await shot('after-save')
  } catch (error) {
    await app.screenshot({ path: `${out}-error-${theme}.png` }).catch(() => {})
    throw error
  } finally {
    await app.close()
    await fixture.close()
    db.close()
  }
}
console.log('saved', out)
process.exit(0)
