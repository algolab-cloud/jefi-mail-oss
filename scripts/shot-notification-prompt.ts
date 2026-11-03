/**
 * Screenshots of the notification permission screen: the onboarding step and the sheet over the
 * app, for an open question and a refusal, in both themes. Runs against the in-memory fixture
 * mailbox with a private config dir; the status is forced, so no real system prompt appears.
 *
 *   bun scripts/shot-notification-prompt.ts [prefix]   → <prefix>-<where>-<variant>-<theme>.png
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'
import { DEFAULT_SETTINGS } from '../src/theme'
import { APP_VERSION } from '../src/version'

const out = process.argv[2] ?? `${process.cwd()}/tmp/notification-prompt`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

type App = Awaited<ReturnType<typeof launch>>
async function waitFor(app: App, testId: string) {
  for (let i = 0; (await app.getByTestId(testId).all().catch(() => [])).length === 0; i++) {
    if (i > 100) throw new Error(`${testId} never appeared`)
    await wait(200)
  }
}

for (const where of ['sheet', 'onboarding'] as const) {
  for (const variant of ['undetermined', 'denied'] as const) {
    for (const [theme, accent] of [['dark', 'violet'], ['light', 'blue']] as const) {
      const home = `${process.cwd()}/tmp/notification-prompt-home-${where}-${variant}-${theme}`
      rmSync(home, { recursive: true, force: true })
      const fixture = await startFixture(home)
      const dir = fixture.env.JEFI_CONFIG_DIR
      if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
      mkdirSync(dir, { recursive: true })
      const onboarded = where === 'sheet'
      writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, style: 'default', theme, accent, onboarded, lastSeenVersion: APP_VERSION }))
      const app = await launch({
        command: 'bun',
        args: ['src/mail.tsx'],
        env: { GPUIX_BACKGROUND: '1', ...(onboarded ? { JEFI_SKIP_ONBOARDING: '1' } : {}), JEFI_FORCE_NOTIFICATION_PROMPT: variant, ...fixture.env },
        cwd: process.cwd(),
      })
      try {
        if (where === 'onboarding') {
          await waitFor(app, 'onboarding-begin')
          await wait(800)
          await app.getByTestId('onboarding-begin').click()
          await waitFor(app, 'onboarding-demo')
          await wait(600)
          await app.getByTestId('onboarding-demo').click()
          await waitFor(app, 'onboarding-style-next')
          await wait(600)
          await app.getByTestId('onboarding-style-next').click()
          await waitFor(app, 'onboarding-notify-later')
        } else {
          await waitFor(app, 'notification-prompt')
        }
        await wait(1500)
        await app.screenshot({ path: `${out}-${where}-${variant}-${theme}.png` })
        // The success state, reached through the forced (pretend) grant.
        if (variant === 'undetermined') {
          await app.getByTestId(where === 'sheet' ? 'notification-prompt-allow' : 'onboarding-notify-allow').click()
          await wait(800)
          await app.screenshot({ path: `${out}-${where}-granted-${theme}.png` })
        }
      } finally {
        await app.close()
        await fixture.close()
      }
    }
  }
}
console.log('saved', out)
process.exit(0)
