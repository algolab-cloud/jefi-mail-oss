/**
 * Screenshots of the attachment cards: the reader grid (resting and with one card hovered), the
 * narrowest window, and compose carrying several files, in dark and light.
 *
 *   bun scripts/shot-attachments.ts [prefix]   → <prefix>-<theme>-{reader,hover,narrow,compose}.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { APP_VERSION } from '../src/version'

const out = process.argv[2] ?? `${process.cwd()}/tmp/attachments`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const LONG = 'Q3-board-presentation-final-v7-approved.pptx'

async function session(theme: 'dark' | 'light', width: number, run: (app: Awaited<ReturnType<typeof launch>>) => Promise<void>) {
  // A throwaway config dir per run, never the real ~/.config/jefi.
  const fixture = await startFixture(`${process.cwd()}/tmp/attachments-home-${theme}-${width}`, { manyAttachments: true })
  const dir = fixture.env.JEFI_CONFIG_DIR!
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent: theme === 'dark' ? 'violet' : 'blue', onboarded: true, lastSeenVersion: APP_VERSION }))
  const app = await launch({
    command: 'bun',
    args: ['src/mail.tsx'],
    env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, JEFI_WINDOW_WIDTH: String(width), ...fixture.env },
    cwd: process.cwd(),
  })
  try {
    for (let i = 0; (await app.getByTestId(`attachment-open-${LONG}`).all().catch(() => [])).length === 0; i++) {
      if (i > 150) throw new Error('the attachment cards never appeared')
      await wait(200)
    }
    await wait(1200)
    await run(app)
  } finally {
    await app.close()
    await fixture.close()
  }
}

for (const theme of ['dark', 'light'] as const) {
  await session(theme, 1440, async (app) => {
    await app.screenshot({ path: `${out}-${theme}-reader.png` })
    await app.getByTestId(`attachment-open-${LONG}`).hover()
    await wait(1000)
    await app.screenshot({ path: `${out}-${theme}-hover.png` })
    await app.mouse.move({ x: 5, y: 5 })

    // Forwarding carries the files into compose.
    await app.getByTestId('action-more').click()
    await wait(300)
    await app.getByTestId('action-forward').click()
    for (let i = 0; (await app.getByTestId('compose-subject').all().catch(() => [])).length === 0; i++) {
      if (i > 100) throw new Error('compose never opened')
      await wait(200)
    }
    await wait(1200)
    await app.screenshot({ path: `${out}-${theme}-compose.png` })
  })
  await session(theme, 1040, async (app) => {
    await app.screenshot({ path: `${out}-${theme}-narrow.png` })
  })
}
console.log('saved', out)
process.exit(0)
