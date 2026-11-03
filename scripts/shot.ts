/**
 * Screenshots of the real app: boots an in-memory IMAP/SMTP mailbox (scripts/testing/fixture.ts),
 * points Jefi at it with an account already configured, and drives the UI through the engine.
 *
 *   bun run screenshot            → tmp/jefi-*.png
 *   bun scripts/shot.ts <prefix>
 */
import { launch } from '@gpuix/react/automation'
import { startFixture } from './testing/fixture'

const out = process.argv[2] ?? 'shot'
const fixture = await startFixture(`${process.cwd()}/tmp/shot-home`)
const app = await launch({
  command: 'bun',
  args: ['src/mail.tsx'],
  env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${process.cwd()}/scripts/testing/faces`, ...fixture.env },
  cwd: process.cwd(),
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const click = async (testId: string) => {
  for (let i = 0; ; i++) {
    try {
      return await app.getByTestId(testId).click()
    } catch (err) {
      if (i >= 10) throw new Error(`could not click ${testId}: ${err}`)
      await wait(200)
    }
  }
}
// Settings sections are virtualized; reveal controls before asking automation to click them.
const revealSetting = async (testId: string, direction: 'up' | 'down') => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const [node] = await app.getByTestId(testId).all()
    const bounds = node?.bounds
    if (bounds && bounds.y >= 70 && bounds.y + bounds.height <= 790) return
    await app.mouse.wheel({ x: 900, y: 450 }, 0, direction === 'down' ? -350 : 350)
    await wait(200)
  }
  throw new Error(`could not reveal setting ${testId}`)
}
const clickText = async (text: string) => {
  const [node] = await app.getByText(text).all()
  const b = node?.bounds
  if (!b) throw new Error(`no element with text ${text}`)
  await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
}
const visible = async (text: string, timeoutMs = 15000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await app.getByText(text).all().catch(() => [])).length > 0) return true
    await wait(200)
  }
  throw new Error(`timed out waiting for "${text}"`)
}

try {
  // Mailbox, once the first sync has landed.
  await visible('Q3 product review')
  await wait(1200)
  await app.screenshot({ path: `${out}-1.png` })

  // Reading a conversation.
  await clickText('Customer feedback')
  await wait(700)
  await app.screenshot({ path: `${out}-2.png` })

  // Settings, light theme, accent.
  await click('nav-settings')
  await wait(600)
  await app.screenshot({ path: `${out}-3.png` })
  await revealSetting('ai-provider-openai', 'down')
  await click('ai-provider-openai')
  await revealSetting('ai-openai-mode-codex', 'down')
  await click('ai-openai-mode-codex')
  await wait(700)
  await app.screenshot({ path: `${out}-3-ai.png` })
  await revealSetting('theme-light', 'up')
  await click('theme-light')
  await wait(600)
  await app.screenshot({ path: `${out}-4.png` })
  await click('toggle-unread-counts')
  await wait(600)
  await app.screenshot({ path: `${out}-5.png` })
  await click('accent-violet')
  await click('nav-inbox')
  await wait(700)
  await app.screenshot({ path: `${out}-6.png` })

  // Compose.
  await click('compose')
  await wait(600)
  await app.getByTestId('compose-to').fill('kenji@northlight.co, ')
  await wait(300)
  await click('compose-show-cc')
  await app.getByTestId('compose-cc').fill('nora@harbor.io ')
  await app.getByTestId('compose-subject').fill('Lunch on Friday?')
  await app.getByTestId('compose-body').fill(
    'Hey @Kenji Ito,\n\nWant to grab **lunch on Friday** and catch up on the _design system_ work?\n\n- [x] Review tokens\n- [ ] Plan roadmap\n\n> Friday works best for me.\n\nMara',
  )
  await wait(700)
  await app.screenshot({ path: `${out}-7.png` })
  await click('compose-mode-preview')
  await wait(600)
  await app.screenshot({ path: `${out}-7-preview.png` })
  await click('compose-mode-write')
  await wait(300)
  await click('compose-send')
  await wait(1200)
  await app.screenshot({ path: `${out}-8.png` })

  // New mail arriving over IDLE, then the other folders.
  fixture.deliver('Standup notes', 'Quick recap from today:\n\nIMAP IDLE works, sending works, labels next.')
  await visible('Standup notes', 10000)
  await wait(600)
  await app.screenshot({ path: `${out}-9.png` })
  // Archive and Trash live under More.
  await click('nav-more')
  for (const folder of ['starred', 'sent', 'drafts', 'archive', 'trash']) {
    await click(`nav-${folder}`)
    await wait(500)
  }
  await app.screenshot({ path: `${out}-10.png` })
} catch (error) {
  console.error(error)
  throw error
} finally {
  await app.close()
  await fixture.close()
}
console.log('saved', out)
// The fixture's servers leave handles open that would keep Bun alive.
process.exit(0)
