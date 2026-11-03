/**
 * Native smoke for lume-s00: GPUIX overlays draw beneath the Full HTML WKWebView, so the web view
 * must be hidden whenever one is open, including when it was first placed under an already open
 * sheet, and must come back once they all close.
 *
 *   bun scripts/testing/overlay-webview.tsx
 *
 * The app appends every native show/hide to JEFI_WEBVIEW_STATE_FILE (automation can't see AppKit
 * views). With JEFI_OVERLAY_SHOTS=1 it also saves real window captures (needs Screen Recording).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { startFixture } from './fixture'
import { DEFAULT_SETTINGS } from '../../src/theme'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const home = `${process.cwd()}/tmp/overlay-webview-home`
const stateFile = `${home}/webview-state.jsonl`
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const fixture = await startFixture(home, { newestHtml: true })
const dir = fixture.env.JEFI_CONFIG_DIR
if (!dir) throw new Error('fixture has no JEFI_CONFIG_DIR')
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/settings.json`, JSON.stringify({ ...DEFAULT_SETTINGS, onboarded: true }))

const app = await launch({
  command: 'bun',
  args: ['src/mail.tsx'],
  env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_FORCE_WHATS_NEW: '1', JEFI_WEBVIEW_STATE_FILE: stateFile, ...fixture.env },
  cwd: process.cwd(),
})

type State = { hidden: boolean; placed: boolean; loaded: boolean; snapshot: boolean }
const lastState = (): State | null => {
  if (!existsSync(stateFile)) return null
  const lines = readFileSync(stateFile, 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!)
}
const until = async (what: string, ok: () => Promise<boolean> | boolean, tries = 75) => {
  for (let i = 0; !(await ok()); i++) {
    if (i > tries) throw new Error(`timed out waiting for ${what} (last web view state ${JSON.stringify(lastState())})`)
    await wait(200)
  }
}
const present = async (testId: string) => (await app.getByTestId(testId).all().catch(() => [])).length > 0
// Real window pixels (the GPUIX screenshot can't include the native web view).
const shot = async (name: string) => {
  if (!process.env.JEFI_OVERLAY_SHOTS) return
  if (!existsSync('tmp/winid')) Bun.spawnSync(['swiftc', '-O', 'scripts/testing/window-ids.swift', '-o', 'tmp/winid'])
  const ids = Bun.spawnSync(['tmp/winid', Bun.spawnSync(['pgrep', '-n', '-f', 'src/mail.tsx']).stdout.toString().trim()]).stdout.toString().trim().split('\n')
    .map((line) => line.split(' ')).filter((f) => f[1] === '0' && Number(f[3]) > 200)
  if (!ids[0]) return console.log('no window to capture')
  Bun.spawnSync(['screencapture', '-x', '-o', '-l', ids[0][0]!, `tmp/overlay-webview-${name}.png`])
}

try {
  await until('the What’s new sheet', () => present('whats-new'))
  // The newest message is HTML, so the reader places its web view under the already open sheet.
  await until('the Full HTML view', () => present('html-full'))
  await until('the page to load', () => lastState()?.loaded === true)
  await wait(800)
  await shot('sheet-open')
  if (!present('whats-new')) throw new Error('the sheet closed before the check')
  if (lastState()?.hidden !== true) throw new Error(`web view drawn over the open sheet: ${JSON.stringify(lastState())}`)

  await app.getByTestId('whats-new-continue').click()
  await until('the sheet to close', async () => !(await present('whats-new')))
  await until('the web view to return', () => lastState()?.hidden === false)
  await wait(500)
  await shot('sheet-closed')

  // An overlay opened over an already visible page: frozen stand-in, then hidden.
  await app.getByTestId('command-bar').click()
  await until('the palette', () => present('palette'))
  await until('the web view to step aside for the palette', () => lastState()?.hidden === true)
  await wait(500)
  await shot('palette-open')
  await app.getByTestId('palette-input').press('escape')
  await until('the web view to return after the palette', () => lastState()?.hidden === false)
  console.log('PASS overlay-webview')
} finally {
  await app.close()
  await fixture.close()
}
process.exit(0)
