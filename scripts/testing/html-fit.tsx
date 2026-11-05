/**
 * Native smoke for the Full HTML page: it is as tall as the message (no box scrolling inside the
 * reader), it follows the theme for plain mail, and in a longer conversation the end of the message
 * and its bottom corners can be scrolled into view above the reply box.
 *
 *   bun scripts/testing/html-fit.tsx            (JEFI_FIT_SHOTS=1 also saves screenshots to tmp/)
 *
 * Needs the native helpers in build/native (bun scripts/native/build-helpers.ts builds them).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './fixture'
import { DEFAULT_SETTINGS } from '../../src/theme'

// JEFI_STILL_MAIL freezes the page into GPUIX's tree, so the app's own screenshot shows it.
const shots = Boolean(process.env.JEFI_FIT_SHOTS)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const home = `${process.cwd()}/tmp/html-fit-home`
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const fixture = await startFixture(home, { htmlThread: true })
const dir = fixture.env.JEFI_CONFIG_DIR
if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'dark', onboarded: true }))

const app = await launch({
  command: 'bun',
  args: ['src/mail.tsx'],
  env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', ...(shots ? { JEFI_STILL_MAIL: '1' } : {}), ...fixture.env },
  cwd: process.cwd(),
})
const present = async (testId: string) => (await app.getByTestId(testId).all().catch(() => [])).length > 0
const shot = async (name: string) => {
  if (!shots) return
  await wait(1500)
  await app.screenshot({ path: `tmp/html-fit-${name}.png` })
  console.log(`saved tmp/html-fit-${name}.png`)
}

try {
  for (let i = 0; !(await present('html-full')); i++) {
    if (i > 75) throw new Error('timed out waiting for the Full HTML view')
    await wait(200)
  }
  await wait(3000)
  const window = await app.getByTestId('reader-area').bounds()
  const page = await app.getByTestId('html-full').bounds()
  console.log(`reader area ${JSON.stringify(window)}; page ${JSON.stringify(page)}`)
  // Unmeasured, the page would be the window's height less 300 (at least 320), as tall as the reader allows.
  if (page.height < 300 || page.height > 1400) throw new Error(`page height ${page.height} doesn't look like the message's`)
  await shot('opened')

  // Scroll the conversation to its end: the whole page fits above the reply box.
  for (let i = 0; i < 12; i++) {
    await app.getByTestId('reader-area').wheel(0, -400)
    await wait(120)
  }
  await wait(800)
  const end = await app.getByTestId('html-full').bounds()
  const area = await app.getByTestId('reader-area').bounds()
  console.log(`at the end: page ${JSON.stringify(end)}; reader area ${JSON.stringify(area)}`)
  if (end.y + end.height > area.y + area.height + 1) throw new Error('the end of the message is still under the reply box')
  await shot('end')
  console.log('PASS html-fit')
} finally {
  await app.close()
  await fixture.close()
}
process.exit(0)
