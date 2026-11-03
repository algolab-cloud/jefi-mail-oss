/**
 * Screenshots of every onboarding step, in both themes, against the in-memory fixture mailbox with a
 * private config dir. The notification status is forced to "not asked yet" so that step shows too.
 *
 *   bun scripts/shot-onboarding.ts [prefix] [--theme=dark|light]   → <prefix>-<step>-<theme>.png
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { APP_VERSION } from '../src/version'

const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--')) ?? `${process.cwd()}/tmp/onboarding/shot`
const only = args.find((a) => a.startsWith('--theme='))?.slice(8)
mkdirSync(dirname(out), { recursive: true })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

type App = Awaited<ReturnType<typeof launch>>
async function waitFor(app: App, testId: string) {
  for (let i = 0; (await app.getByTestId(testId).all().catch(() => [])).length === 0; i++) {
    if (i > 100) throw new Error(`${testId} never appeared`)
    await wait(200)
  }
}

for (const theme of (['light', 'dark'] as const).filter((t) => !only || t === only)) {
  const home = `${process.cwd()}/tmp/onboarding-home-${theme}`
  rmSync(home, { recursive: true, force: true })
  const fixture = await startFixture(home)
  const dir = fixture.env.JEFI_CONFIG_DIR
  if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent: 'violet', onboarded: false, lastSeenVersion: APP_VERSION }))
  const app = await launch({
    command: 'bun',
    args: ['src/mail.tsx'],
    env: { GPUIX_BACKGROUND: '1', JEFI_FORCE_NOTIFICATION_PROMPT: 'undetermined', ...fixture.env },
    cwd: process.cwd(),
  })
  // Each step: wait for something on it, let the entrance settle, take the picture.
  const shot = async (step: string, ready: string) => {
    await waitFor(app, ready)
    await wait(3000)
    await app.screenshot({ path: `${out}-${step}-${theme}.png` })
  }
  try {
    await shot('1-welcome', 'onboarding-begin')
    await app.getByTestId('onboarding-begin').click()
    await shot('2-mail', 'provider-gmail')
    await app.getByTestId('provider-fastmail').click()
    await shot('3-connect', 'wizard-cancel')
    await app.getByTestId('wizard-cancel').click()
    await waitFor(app, 'onboarding-demo')
    await wait(500)
    await app.getByTestId('onboarding-demo').click()
    await shot('4-style', 'onboarding-style-next')
    await app.getByTestId('onboarding-style-next').click()
    await shot('5-notify', 'onboarding-notify-later')
    await app.getByTestId('onboarding-notify-later').click()
    await shot('6-license', 'onboarding-license-next')
    await app.getByTestId('onboarding-license-next').click()
    await shot('7-done', 'onboarding-finish')
  } finally {
    await app.close()
    await fixture.close()
  }
}
console.log('saved', out)
process.exit(0)
