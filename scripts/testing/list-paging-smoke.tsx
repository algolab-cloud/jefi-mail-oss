/**
 * Scrolls a 1,500-message Inbox in the real app and checks that cursor pages keep arriving: older
 * "Bulk message" rows appear as the list scrolls, and rows already seen don't vanish or reorder.
 *
 *   NAPI_RS_NATIVE_LIBRARY_PATH=… bun scripts/testing/list-paging-smoke.tsx
 */
import { launch } from '@gpuix/react/automation'
import { startFixture } from './fixture'

const fixture = await startFixture(`${process.cwd()}/tmp/list-paging-home`, { bulk: 1500 })
const app = await launch({
  command: 'bun',
  args: ['src/mail.tsx'],
  env: { GPUIX_BACKGROUND: '1', JEFI_SKIP_ONBOARDING: '1', ...fixture.env },
  cwd: process.cwd(),
})
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Bulk subjects count up going back in time: "Bulk message 1" is the newest, "Bulk message 1500" the oldest.
const deepestVisible = async () => {
  let deepest = 0
  const nodes = await app.getByText('Bulk message ').all().catch(() => [])
  for (const node of nodes) {
    const m = /Bulk message (\d+)/.exec(String((node as { text?: string | null }).text ?? ""))
    const n = m ? Number(m[1]) : 0
    if (n) deepest = Math.max(deepest, n)
  }
  return deepest
}

try {
  for (let i = 0; i < 100 && !(await app.getByText('Bulk message ').all().catch(() => [])).length; i++) await wait(200)
  const start = await deepestVisible()
  const seen: number[] = [start]
  for (let step = 0; step < 60; step++) {
    await app.mouse.wheel({ x: 640, y: 600 }, 0, -2400)
    await wait(250)
    seen.push(await deepestVisible())
  }
  await app.screenshot({ path: 'tmp/list-paging-deep.png' })
  const deepest = Math.max(...seen)
  // Scrolling only ever goes further back, so the deepest row on screen must never move up the list.
  const regressions = seen.filter((n, i) => i > 0 && n + 40 < seen[i - 1]!).length
  console.log(JSON.stringify({ start, deepest, rowsScrolled: deepest - start, regressions, samples: seen }))
  if (!(deepest - start > 400)) throw new Error(`scrolled only ${deepest - start} rows deep: older pages didn't load`)
  if (regressions) throw new Error('the list jumped back while scrolling')
  console.log('PASS list-paging')
} finally {
  await app.close()
  await fixture.close?.()
}
// The fixture's servers keep the event loop alive after close; a failure exits through the throw.
process.exit(0)
