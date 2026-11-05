import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { DEFAULT_SETTINGS, SettingsContext, palette } from './theme'
import { IconButton } from './icons'

// GPUIX's test renderer reads frames back from the GPU: macOS and Windows only (see compose.test.tsx).
const rendererSupported = process.platform !== 'linux'
const C = palette('dark', 'red')
let root: TestRoot
beforeEach(() => {
  if (rendererSupported) root = createTestRoot({ width: 600, height: 400 })
})
afterEach(() => {
  if (rendererSupported) root.unmount()
})
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The reader's toolbar sits at the top of the window: there's no room above its buttons for a tooltip.
test.skipIf(!rendererSupported)('a tooltip with no room above opens below its button and stays while hovered', async () => {
  root.render(
    <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, C, update: () => {} }}>
      <div style={{ width: 600, height: 400, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'flex-end', paddingTop: 8, paddingRight: 40 }}>
        <IconButton icon="sparkles" size={17} tooltip="Summarize with ChatGPT" onClick={() => {}} testId="summarize" />
      </div>
    </SettingsContext.Provider>,
  )
  root.renderer.flush()
  const button = root.renderer.getElementBounds(root.renderer.findByTestId('summarize')!.id)!
  const seen: boolean[] = []
  for (let i = 0; i < 16; i++) {
    root.renderer.nativeSimulateMouseMove(button.x + button.width / 2, button.y + button.height / 2 + (i % 2))
    root.renderer.dispatchNativeEvents()
    root.renderer.flush()
    seen.push(Boolean(root.renderer.findByText('Summarize with ChatGPT')))
    await wait(80)
  }
  // Hidden for the hover delay, then shown for good: never closing and reopening under the pointer.
  const first = seen.indexOf(true)
  expect(first).toBeGreaterThan(0)
  expect(seen.slice(first).every(Boolean)).toBe(true)
  const tip = root.renderer.getElementBounds(root.renderer.findByText('Summarize with ChatGPT')!.id)!
  expect(tip.y).toBeGreaterThanOrEqual(button.y + button.height)
})

test('only a top tooltip without room above moves below', async () => {
  const { tooltipSide } = await import('./tooltip')
  expect(tooltipSide('top', 8)).toBe('bottom')
  expect(tooltipSide('top', 300)).toBe('top')
  expect(tooltipSide('top', null)).toBe('top')
  expect(tooltipSide('right', 8)).toBe('right')
})
