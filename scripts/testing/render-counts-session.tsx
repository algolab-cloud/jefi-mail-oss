/**
 * Drives a realistic session in the real app with render counting on (src/render-counts.ts) and
 * prints how often each mail-store consumer rendered in each phase: first sync with backfill, opening
 * a few conversations, typing a search, and typing a reply. Run it before and after a store change to
 * compare fan-out.
 *
 *   NAPI_RS_NATIVE_LIBRARY_PATH=… bun scripts/testing/render-counts-session.tsx
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { launch, type TreeNode } from '@gpuix/react/automation'
import { startFixture } from './fixture'

const countsFile = `${process.cwd()}/tmp/render-counts.json`
rmSync(countsFile, { force: true })
const fixture = await startFixture(`${process.cwd()}/tmp/render-counts-home`, { bulk: 400 })
const app = await launch({
  command: 'bun',
  args: ['src/mail.tsx'],
  env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', JEFI_RENDER_COUNTS: countsFile, ...fixture.env },
  cwd: process.cwd(),
})
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Counts = Record<string, number>
const read = async (): Promise<Counts> => {
  // The app writes the file every 500ms; wait a beat so it holds this phase's renders.
  await wait(700)
  return existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {}
}
const phases: Record<string, Counts> = {}
let last: Counts = {}
const mark = async (phase: string) => {
  const now = await read()
  phases[phase] = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v - (last[k] ?? 0)]).filter(([, v]) => v))
  last = now
}

/** Clicks the `index`th conversation row painted on screen (the list mounts a few off-screen too). */
const clickRow = async (index: number) => {
  const ids: string[] = []
  const walk = (node: TreeNode) => {
    if (node.testId?.startsWith('thread-')) ids.push(node.testId)
    node.children?.forEach(walk)
  }
  const { tree } = await app.call('getTree', {})
  if (tree) walk(tree)
  const painted: string[] = []
  for (const id of ids) if (await app.getByTestId(id).bounds().then(() => true, () => false)) painted.push(id)
  const testId = painted[index]
  if (!testId) throw new Error(`no row ${index} on screen`)
  await app.getByTestId(testId).click()
}

const typeInto = async (testId: string, text: string) => {
  await app.getByTestId(testId).click()
  for (const ch of text) {
    await app.getByTestId(testId).press(ch === ' ' ? 'space' : ch)
    await wait(40)
  }
}

try {
  for (let i = 0; i < 150 && !(await app.getByText('Q3 product review').all().catch(() => [])).length; i++) await wait(200)
  // Let the first sync, snippet backfill and paging settle.
  await wait(6000)
  // A fresh config gets the release notes sheet over the window.
  await app.getByTestId('whats-new-continue').click().catch(() => {})
  await wait(500)
  await mark('sync')

  for (const index of [0, 1, 2, 3]) {
    await clickRow(index)
    await wait(600)
  }
  await mark('select')

  await typeInto('search', 'launch')
  await wait(1500)
  await mark('search')
  await app.getByTestId('search-clear').click().catch(() => {})
  await wait(800)
  await clickRow(0)
  await wait(800)
  await mark('clear')

  await typeInto('composer', 'Thanks, looks good to me')
  await wait(800)
  await mark('reply')
} finally {
  await app.close()
  await fixture.close?.()
}

const names = [...new Set(Object.values(phases).flatMap(Object.keys))]
const total = (name: string) => Object.values(phases).reduce((sum, p) => sum + (p[name] ?? 0), 0)
names.sort((a, b) => total(b) - total(a))
const cols = Object.keys(phases)
console.log(['component', ...cols, 'total'].join('\t'))
for (const name of names) console.log([name, ...cols.map((c) => phases[c]![name] ?? 0), total(name)].join('\t'))
console.log(JSON.stringify(phases))
process.exit(0)
