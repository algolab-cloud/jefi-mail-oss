/**
 * Native smoke for lume-c0k: with a Full HTML message open and the app idle, the web view's bounds
 * poll backs off (60 ms while moving, 500 ms once settled), and scrolling the reader brings it
 * straight back so the web view follows the scroll without a half-second lag.
 *
 *   bun scripts/testing/html-placement-idle.tsx
 *
 * The app appends every placement poll to JEFI_PLACEMENT_LOG.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './fixture'
import { DEFAULT_SETTINGS } from '../../src/theme'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const home = `${process.cwd()}/tmp/html-placement-idle-home`
const log = `${home}/placement.jsonl`
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
// A conversation that runs past the reader (a three-message thread in a short window), so there's
// something to scroll: the page is only as tall as its message, so a short one alone would fit.
const fixture = await startFixture(home, { htmlThread: true })
const dir = fixture.env.JEFI_CONFIG_DIR
if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, onboarded: true }))

const app = await launch({
  command: 'bun',
  args: ['src/mail.tsx'],
  env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_WINDOW: '1440x640', JEFI_PLACEMENT_LOG: log, ...fixture.env },
  cwd: process.cwd(),
})

type Poll = { t: number; moved: boolean }
const polls = (): Poll[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const rate = (from: number, to: number) => polls().filter((p) => p.t >= from && p.t < to).length / ((to - from) / 1000)
const present = async (testId: string) => (await app.getByTestId(testId).all().catch(() => [])).length > 0

try {
  for (let i = 0; !(await present('html-full')); i++) {
    if (i > 75) throw new Error('timed out waiting for the Full HTML view')
    await wait(200)
  }
  // Let loading, layout and the first placement settle, then measure an idle stretch.
  await wait(6000)
  const idleFrom = Date.now()
  await wait(5000)
  const idle = rate(idleFrom, Date.now())
  console.log(`idle: ${idle.toFixed(1)} placement polls/s (was ${(1000 / 60).toFixed(1)} with the fixed 60 ms interval)`)
  if (idle > 3) throw new Error(`placement poll didn't back off: ${idle.toFixed(1)}/s`)

  const before = await app.getByTestId('html-full').bounds()
  const scrolledAt = Date.now()
  await app.getByTestId('reader-area').wheel(0, -200)
  await wait(400)
  const moved = await app.getByTestId('html-full').bounds()
  console.log(`html-full y ${before.y} -> ${moved.y}`)
  const after = polls().filter((p) => p.t >= scrolledAt)
  const firstMove = after.find((p) => p.moved)
  if (!firstMove) throw new Error('the web view never followed the scroll')
  const lag = firstMove.t - scrolledAt
  console.log(`scroll: web view moved ${lag} ms after the wheel; ${after.length} polls in the next 400 ms`)
  if (lag > 250) throw new Error(`the web view lagged the scroll by ${lag} ms`)
  console.log('PASS html-placement-idle')
} finally {
  await app.close()
  await fixture.close()
}
process.exit(0)
