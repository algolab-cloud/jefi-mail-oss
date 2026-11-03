/**
 * Screenshots of the app rail and the context column in both themes, against the in-memory fixture
 * mailbox (never ~/.config/jefi): Mail, Mail with More and the sections open, Calendar, Notes, the
 * assistant, the account menu, the collapsed column, a rail tooltip, and the smallest window.
 *
 *   bun scripts/shot-sidebar.ts [prefix]   → <prefix>-<shot>-<theme>.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { APP_VERSION } from '../src/version'
import { openDatabase } from '../src/engine/db'
import { createImapEngine } from '../src/engine/imap-engine'
import { saveNote } from '../src/engine/calendar/notes'

const out = process.argv[2] ?? `${process.cwd()}/tmp/sidebar`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MINUTE = 60_000

/** A few calendars and events (one starting in ten minutes, for the rail's dot), and two notes. */
async function seed(dbPath: string) {
  const db = openDatabase(dbPath)
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, watch: false, wake: false })
  const [personal] = await engine.listCalendars()
  await engine.updateCalendar(personal!.id, { color: '#12A594' })
  const work = await engine.createLocalCalendar({ name: 'Work', color: '#3E63DD' })
  await engine.createLocalCalendar({ name: 'Family', color: '#D6409F' })
  const soon = Math.ceil((Date.now() + 10 * MINUTE) / MINUTE) * MINUTE
  await engine.saveEvent({ calendarId: work.id, title: 'Design review', startAt: soon, endAt: soon + 45 * MINUTE, location: 'Studio 4B' })
  await engine.saveEvent({ calendarId: personal!.id, title: 'Lunch with Nora', startAt: soon + 3 * 60 * MINUTE, endAt: soon + 4 * 60 * MINUTE })
  saveNote(db, { title: 'Offsite ideas', body: 'Walk through the roadmap, then a long lunch.', pinned: true })
  saveNote(db, { title: 'Reading list', body: '- Shape Up\n- The Mom Test' })
  engine.dispose()
  db.close()
}

type Run = { theme: 'dark' | 'light'; accent: 'violet' | 'blue'; window?: string; tag?: string }
const runs: Run[] = [
  { theme: 'dark', accent: 'violet' },
  { theme: 'light', accent: 'blue' },
  { theme: 'dark', accent: 'violet', window: '1040x620', tag: 'small' },
  { theme: 'light', accent: 'blue', window: '1040x620', tag: 'small' },
]

for (const run of runs) {
  const { theme } = run
  const home = `${process.cwd()}/tmp/sidebar-home-${theme}${run.tag ? `-${run.tag}` : ''}`
  const fixture = await startFixture(home)
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir?.startsWith(process.cwd())) throw new Error('refusing to seed outside the temporary fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent: run.accent, onboarded: true, lastSeenVersion: APP_VERSION, aiEnabled: true }))
  await seed(`${dir}/mail.db`)
  const app = await launch({
    command: 'sh',
    args: ['-c', `exec bun src/mail.tsx 2>>'${out}-app.log'`],
    env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, ...(run.window ? { JEFI_WINDOW: run.window } : {}), ...fixture.env },
    cwd: process.cwd(),
  })
  const has = async (testId: string) => (await app.getByTestId(testId).count().catch(() => 0)) > 0
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
  /** Clicks until `until` shows: the first clicks after launch can be lost. */
  const reach = async (testId: string, until: string) => {
    for (let i = 0; !(await has(until)); i++) {
      if (i > 20) throw new Error(`${until} never appeared after clicking ${testId}`)
      await click(testId)
      await wait(500)
    }
  }
  const shot = async (name: string, keepPointer = false) => {
    // Park the pointer on the reader so a rail tooltip doesn't linger in the picture.
    if (!keepPointer) await app.mouse.move({ x: 900, y: 500 }).catch(() => {})
    await wait(700)
    await app.screenshot({ path: `${out}-${run.tag ? `${run.tag}-` : ''}${name}-${theme}.png` })
  }
  try {
    for (let i = 0; (await app.getByText('Q3 product review').all().catch(() => [])).length === 0; i++) {
      if (i > 100) throw new Error('mail never synced')
      await wait(200)
    }
    await wait(1200)
    if (run.tag === 'small') {
      await reach('nav-more', 'nav-trash')
      await shot('mail')
      await reach('nav-calendar', 'calendar-pane')
      await shot('calendar')
      continue
    }
    await shot('mail')
    await app.getByTestId('nav-mail').hover()
    await shot('tooltip', true)
    await reach('nav-more', 'nav-trash')
    await click('nav-trash')
    await shot('mail-more')
    await click('nav-inbox')
    await reach('nav-calendar', 'calendar-pane')
    await shot('calendar')
    await reach('nav-notes', 'notes')
    await shot('notes')
    await reach('nav-mail', 'mail-sidebar')
    await reach('nav-assistant', 'assistant')
    await shot('assistant')
    await click('nav-assistant')
    await reach('rail-account', 'account-menu')
    await shot('account-menu')
    await click('rail-account').catch(() => {})
    await wait(300)
    await reach('sidebar-toggle', 'app-rail')
    for (let i = 0; (await has('mail-sidebar')) && i < 10; i++) {
      await click('sidebar-toggle')
      await wait(400)
    }
    await shot('collapsed')
    await click('sidebar-toggle')
    // Leave More closed for the next launch's settings; this home is thrown away anyway.
  } catch (error) {
    await app.screenshot({ path: `${out}-error-${theme}.png` }).catch(() => {})
    throw error
  } finally {
    await app.close()
    await fixture.close()
  }
}
console.log('saved', out)
process.exit(0)
