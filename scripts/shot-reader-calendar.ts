/**
 * Screenshots of the reader's calendar and notes pieces in both themes, against the fixture mailbox
 * (with its calendar samples): date suggestions, quick add, "Added", Add to notes and linked chips.
 *
 *   bun scripts/shot-reader-calendar.ts [prefix]   → <prefix>-<theme>-<step>.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'

const out = process.argv[2] ?? `${process.cwd()}/tmp/reader-calendar`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const [theme, accent] of [['dark', 'violet'], ['light', 'blue']] as const) {
  // Never the real ~/.config/jefi: the fixture's config dir is private to this run.
  const fixture = await startFixture(`${process.cwd()}/tmp/reader-calendar-home-${theme}`, { calendar: true })
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded: true, lastSeenVersion: (await Bun.file('package.json').json()).version }))
  const app = await launch({
    command: 'bun',
    args: ['src/mail.tsx'],
    env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, ...fixture.env },
    cwd: process.cwd(),
  })
  const visible = async (text: string, timeoutMs = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if ((await app.getByText(text).all().catch(() => [])).length > 0) return
      await wait(200)
    }
    throw new Error(`timed out waiting for "${text}"`)
  }
  const clickText = async (text: string) => {
    await visible(text)
    const [node] = await app.getByText(text).all()
    const b = node!.bounds!
    await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
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
  const shot = async (step: string) => {
    await wait(700)
    await app.screenshot({ path: `${out}-${theme}-${step}.png` })
  }
  try {
    await clickText('Design review')
    await visible('Add to calendar')
    await shot('1-suggestion')
    // The strip may still be settling after the reader opens; press until the form is up.
    for (let i = 0; (await app.getByTestId('quick-add').all().catch(() => [])).length === 0; i++) {
      if (i > 10) throw new Error('quick add never opened')
      await clickText('Add to calendar')
      await wait(400)
    }
    await shot('2-quick-add')
    await click('quick-add-save')
    await visible('Added')
    await shot('3-added')
    await click('action-add-to-notes')
    await click('add-to-notes-new')
    await wait(400)
    await shot('4-note-added')
    await click('action-add-to-notes')
    await visible('Add to a recent note')
    await shot('5-notes-picker')
    await app.keyboard?.press?.('Escape')
    await clickText('Team offsite')
    await visible('Add to calendar')
    await shot('6-range')
  } catch (error) {
    await app.screenshot({ path: `${out}-${theme}-error.png` }).catch(() => {})
    throw error
  } finally {
    await app.close()
    await fixture.close()
  }
}
console.log('saved', out)
process.exit(0)
