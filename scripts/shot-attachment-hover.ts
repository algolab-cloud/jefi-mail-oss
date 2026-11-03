/**
 * Hover steadiness of an attachment card's actions: rests the pointer on a card, then on its Quick
 * Look button, and takes a burst of screenshots at each spot so a blink would show up as a frame
 * without the buttons (or without the tooltip, once it's due).
 *
 *   bun scripts/shot-attachment-hover.ts [prefix]   → <prefix>-{card,button}-<n>.png, <prefix>-away.png
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { APP_VERSION } from '../src/version'

const out = process.argv[2] ?? `${process.cwd()}/tmp/attachment-hover`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const NAME = 'Q3-board-presentation-final-v7-approved.pptx'

// A throwaway config dir, never the real ~/.config/jefi.
const fixture = await startFixture(`${process.cwd()}/tmp/attachment-hover-home`, { manyAttachments: true })
const dir = fixture.env.JEFI_CONFIG_DIR!
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme: 'dark', onboarded: true, lastSeenVersion: APP_VERSION }))
const app = await launch({
  command: 'bun',
  args: ['src/mail.tsx'],
  env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_WINDOW_WIDTH: '1440', ...fixture.env },
  cwd: process.cwd(),
})
try {
  for (let i = 0; (await app.getByTestId(`attachment-open-${NAME}`).all().catch(() => [])).length === 0; i++) {
    if (i > 150) throw new Error('the attachment cards never appeared')
    await wait(200)
  }
  await wait(1200)
  // Glide there in small steps like a real pointer; a single jump skips the enter/leave sequence.
  let at = { x: 5, y: 5 }
  const glide = async (to: { x: number; y: number }) => {
    for (let i = 1; i <= 20; i++) {
      await app.mouse.move({ x: at.x + ((to.x - at.x) * i) / 20, y: at.y + ((to.y - at.y) * i) / 20 })
      await wait(16)
    }
    at = to
  }
  const burst = async (spot: string) => {
    for (let n = 0; n < 5; n++) {
      await wait(200)
      await app.screenshot({ path: `${out}-${spot}-${n}.png` })
      console.log(spot, n, 'tooltip', await app.getByText('Quick Look').count())
    }
  }
  const card = await app.getByTestId(`attachment-open-${NAME}`).bounds()
  const button = await app.getByTestId(`attachment-preview-${NAME}`).bounds()
  at = { x: card.x - 20, y: card.y + card.height / 2 }
  await app.mouse.move(at)
  await glide({ x: card.x + 40, y: card.y + card.height / 2 })
  await burst('card')
  await glide({ x: button.x + button.width / 2, y: button.y + button.height / 2 })
  await burst('button')
  // Leaving from a button (not the card body) must still fade the actions.
  await glide({ x: button.x + button.width / 2, y: card.y - 40 })
  await wait(400)
  await app.screenshot({ path: `${out}-away.png` })
} finally {
  await app.close()
  await fixture.close()
}
console.log('saved', out)
process.exit(0)
