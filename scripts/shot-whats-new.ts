/**
 * Screenshots of the "What's new" sheet in both themes, against the in-memory fixture mailbox.
 *
 *   bun scripts/shot-whats-new.ts [prefix]   → <prefix>-dark.png, <prefix>-light.png
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'

const out = process.argv[2] ?? `${process.cwd()}/tmp/whats-new`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const [theme, accent] of [['dark', 'violet'], ['light', 'blue']] as const) {
  const home = `${process.cwd()}/tmp/whats-new-home-${theme}`
  rmSync(home, { recursive: true, force: true })
  const fixture = await startFixture(home)
  // Seed the theme before launch; the fixture's config dir is private to this run.
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded: true }))
  const app = await launch({
    command: 'bun',
    args: ['src/mail.tsx'],
    env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_FORCE_WHATS_NEW: '1', ...fixture.env },
    cwd: process.cwd(),
  })
  try {
    for (let i = 0; (await app.getByTestId('whats-new').all().catch(() => [])).length === 0; i++) {
      if (i > 100) throw new Error('the sheet never appeared')
      await wait(200)
    }
    await wait(1500)
    await app.screenshot({ path: `${out}-${theme}.png` })
  } finally {
    await app.close()
    await fixture.close()
  }
}
console.log('saved', out)
process.exit(0)
