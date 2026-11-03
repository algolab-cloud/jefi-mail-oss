/**
 * The menu bar item and its panel in both themes, against the fixture mailbox with a day of events
 * seeded through the engine. Also checks the window lifecycle: closing the window leaves the process
 * running with the window hidden, and "Open Jefi" brings it back. Dark runs the shipped Objective-C
 * helper (built fresh into tmp/), light the development JS fallback.
 *
 *   bun scripts/shot-menubar.ts [prefix]   → <prefix>-panel-<theme>.png, <prefix>-bar-<theme>.png, …
 *                                             <prefix>-glass-<light|dark>-<light|dark|busy>.png (the panel
 *                                             in place over a temporary backdrop window), …-glass-live-flip.png
 *
 * It opens the real status item on this Mac's menu bar (and brings Jefi forward to do it).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { buildLifecycleHelper } from './native/build-lifecycle'
import { DEFAULT_SETTINGS, type Settings } from '../src/theme'
import { openDatabase } from '../src/engine/db'
import { createImapEngine } from '../src/engine/imap-engine'
import { addDays, startOfDay } from '../src/calendar/dates'

const root = process.cwd()
const out = process.argv[2] ?? `${root}/tmp/menubar`
mkdirSync(`${root}/tmp`, { recursive: true })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MIN = 60_000

const helper = `${root}/tmp/libJefiLifecycle.dylib`
buildLifecycleHelper(helper)

/** A day around now: something just finished, the next thing in 25 minutes, more later, and a busy month. */
async function seed(dbPath: string) {
  const db = openDatabase(dbPath)
  const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, watch: false, wake: false })
  const [personal] = await engine.listCalendars()
  await engine.updateCalendar(personal!.id, { color: '#12A594' })
  const work = await engine.createLocalCalendar({ name: 'Work', color: '#3E63DD' })
  const family = await engine.createLocalCalendar({ name: 'Family', color: '#D6409F' })
  await engine.updateCalendar(work.id, { isDefault: true })
  const now = Math.floor(Date.now() / (5 * MIN)) * 5 * MIN
  const today = startOfDay(Date.now())
  const utcDay = (offset: number) => {
    const d = new Date(addDays(today, offset))
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  }
  const timed = (calendarId: string, title: string, start: number, minutes: number, location?: string) =>
    engine.saveEvent({ calendarId, title, startAt: start, endAt: start + minutes * MIN, location })
  await engine.saveEvent({ calendarId: family.id, title: 'Mom’s birthday', allDay: true, startAt: utcDay(0), endAt: utcDay(1) })
  await timed(work.id, 'Design review', now - 95 * MIN, 60, 'Studio 4B')
  await timed(work.id, 'Standup', now + 25 * MIN, 15, 'Zoom')
  await timed(personal!.id, 'Lunch with Nora', now + 110 * MIN, 60, 'Harbor Café')
  await timed(work.id, 'Q3 product review', now + 200 * MIN, 90, 'Boardroom')
  await timed(family.id, 'School pickup', now + 320 * MIN, 30)
  for (const [offset, title] of [[2, 'Dentist'], [3, 'Roadmap sync'], [6, 'Yoga'], [9, 'Board prep'], [13, 'Piano recital'], [-4, 'Haircut'], [-9, 'Vendor demo']] as const) {
    await timed(offset % 2 ? work.id : personal!.id, title, addDays(today, offset) + 10 * 60 * MIN, 60)
  }
  // Tasks the panel lists: one overdue, two due today, one later (left out).
  await engine.saveTask({ title: 'Send Lea the pricing numbers', dueAt: utcDay(-1), dueAllDay: true, origin: 'email' })
  await engine.saveTask({ title: 'Reply to Nora about onboarding', dueAt: utcDay(0), dueAllDay: true })
  await engine.saveTask({ title: 'Review the new icon set', dueAt: now + 240 * MIN })
  await engine.saveTask({ title: 'Book the offsite venue', dueAt: utcDay(4), dueAllDay: true })
  engine.dispose()
  db.close()
}

const results: string[] = []
const check = (ok: boolean, what: string) => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) console.error(`FAIL ${what}`)
}

for (const [theme, accent, title, useHelper] of [['dark', 'violet', 'next', true], ['light', 'blue', 'unread', false]] as const) {
  const home = `${root}/tmp/menubar-home-${theme}`
  const fixture = await startFixture(home, { calendar: true })
  const dir = fixture.env.JEFI_CONFIG_DIR!
  if (!dir.startsWith(`${root}/tmp/`)) throw new Error('refusing to write settings outside the temporary fixture')
  const settings: Settings = { ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded: true, lastSeenVersion: '99.0.0', menuBar: true, menuBarTitle: title }
  writeFileSync(`${dir}/settings.json`, JSON.stringify(settings))
  await seed(`${dir}/mail.db`)
  const log = `${out}-app-${theme}.log`
  writeFileSync(log, '')
  const commandFile = `${home}/menubar-command`
  const app = await launch({
    command: 'sh',
    args: ['-c', `exec bun src/mail.tsx 2>>'${log}'`],
    env: {
      GPUIX_BACKGROUND: '1',
      JEFI_SKIP_ONBOARDING: '1',
      JEFI_MENUBAR_DEBUG: commandFile,
      ...(useHelper ? { JEFI_LIFECYCLE_HELPER: helper } : {}),
      ...fixture.env,
    },
    cwd: root,
  })
  /** Sends one debug command and returns its report line's fields. */
  let pid = 0
  const command = async (text: string) => {
    const seen = readFileSync(log, 'utf8').length
    writeFileSync(commandFile, text)
    process.kill(pid, 'SIGUSR1')
    const verb = text.split(' ')[0]
    for (let i = 0; i < 50; i++) {
      await wait(100)
      const line = readFileSync(log, 'utf8').slice(seen).split('\n').find((l) => l.startsWith(`[menubar] ${verb} `))
      if (line) return Object.fromEntries(line.split(' ').slice(2).map((pair) => pair.split('='))) as Record<string, string>
    }
    throw new Error(`no answer to ${text}`)
  }
  try {
    for (let i = 0; !(pid = Number(readFileSync(log, 'utf8').match(/\[menubar\] ready pid=(\d+)/)?.[1] ?? 0)); i++) {
      if (i > 100) throw new Error('the menu bar item never came up')
      await wait(200)
    }
    for (let i = 0; (await app.getByText('Q3 product review').all().catch(() => [])).length === 0; i++) {
      if (i > 100) throw new Error('mail never synced')
      await wait(200)
    }
    await wait(1500)
    // New mail while running, so the panel's Recent list has something in it.
    await fixture.deliver('Launch checklist for Tuesday', 'Changelog is drafted; the pricing page is waiting on your numbers.')
    for (let i = 0; (await app.getByText('Launch checklist for Tuesday').all().catch(() => [])).length === 0; i++) {
      if (i > 100) throw new Error('the new message never arrived')
      await wait(200)
    }
    await wait(1000)

    // The item in the bar, with some of its neighbours for context. (Status items are drawn by the
    // system on recent macOS, so the app reports where its button is rather than owning a window.)
    const [x, y, w, h] = ((await command('state')).item ?? '').split(',').map(Number)
    check(w! > 0 && h! > 0, `${theme}: the status item is in the menu bar`)
    if (w) Bun.spawnSync(['screencapture', '-x', '-R', `${x! - 90},${y},${w + 180},${h}`, `${out}-bar-${theme}.png`])
    // The button on its own too: on a crowded notched bar the item can sit under the notch.
    await command(`item-png ${out}-item-${theme}.tiff`)
    Bun.spawnSync(['sips', '-s', 'format', 'png', `${out}-item-${theme}.tiff`, '--out', `${out}-item-${theme}.png`], { stdout: 'ignore' })

    const opened = await command('click')
    check(opened.panel === '1' && Number(opened.window) > 0, `${theme}: panel opens from the item`)
    await wait(900)
    Bun.spawnSync(['screencapture', '-x', '-o', '-l', opened.window!, `${out}-panel-${theme}.png`])
    // A second click on the item closes it again.
    check((await command('click')).panel === '0', `${theme}: clicking the item again closes the panel`)

    // The glass in place, over known backdrops in both appearances (pinned on the popover alone:
    // the system appearance and wallpaper are left alone). Once is enough, the Jefi theme doesn't
    // change the panel.
    if (theme === 'dark') {
      // Opened from closed, and settled: with several displays, activating can move the item to
      // another menu bar and take a transient popover down with it, so it gets a second try.
      const openPanel = async () => {
        await command('close')
        for (let i = 0; i < 2; i++) {
          await command('click')
          await wait(900)
          const state = await command('state')
          if (state.panel === '1') return state
        }
        return command('state')
      }
      /** The panel where it stands on screen, glass and whatever is behind it included. */
      const shoot = (state: Record<string, string>, path: string) => {
        const [x, y, w, h] = (state.frame ?? '').split(',').map(Number)
        if (w) Bun.spawnSync(['screencapture', '-x', '-R', `${x! - 16},${y! - 4},${w + 32},${h! + 20}`, path])
        return w! > 0
      }
      try {
        for (const look of ['light', 'dark'] as const) {
          await command(`appearance ${look}`)
          for (const backdrop of ['light', 'dark', 'busy'] as const) {
            await command(`backdrop ${backdrop}`)
            const shown = await openPanel()
            const shot = shoot(shown, `${out}-glass-${look}-${backdrop}.png`)
            check(shown.panel === '1' && shown.appearance === look && shot, `${look} appearance over a ${backdrop} backdrop: panel open (glass=${shown.glass})`)
            // Closed before the next backdrop goes up, or the new window can end up over the popover.
            await command('close')
          }
        }
        // Live: an open panel follows an appearance change without reopening.
        await command('appearance light')
        await openPanel()
        const flipped = await command('appearance dark')
        check(flipped.panel === '1' && flipped.appearance === 'dark', 'the open panel follows an appearance change')
        await wait(500)
        shoot(flipped, `${out}-glass-live-flip.png`)
      } finally {
        await command('close')
        await command('appearance system')
        await command('backdrop none')
      }
    }

    // Lifecycle: close the window, still alive and hidden; then "Open Jefi" from the panel.
    const closed = await command('close-window')
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    check(closed.visible === '0' && alive, `${theme}: closing the window hides it and the process stays (${closed.backend})`)
    await wait(3000)
    const still = await command('click')
    check(still.panel === '1', `${theme}: the panel still works with the window closed`)
    await wait(700)
    Bun.spawnSync(['screencapture', '-x', '-o', '-l', still.window!, `${out}-panel-closed-${theme}.png`])
    const reopened = await command('message {"type":"open-jefi"}')
    check(reopened.visible === '1' && reopened.panel === '0', `${theme}: Open Jefi brings the window back`)

    // Quick add → the event editor, prefilled.
    await command('message {"type":"quick-add","arg":"Lunch with Nora Friday 1pm"}')
    await wait(900)
    const titleField = await app.getByTestId('event-title').count()
    check(titleField > 0, `${theme}: quick add opens the event editor`)
    await app.screenshot({ path: `${out}-quick-add-${theme}.png` })
  } catch (error) {
    await app.screenshot({ path: `${out}-error-${theme}.png` }).catch(() => {})
    throw error
  } finally {
    await app.close()
    await fixture.close()
  }
}
console.log(results.join('\n'))
console.log('saved', out)
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
