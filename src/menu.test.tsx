import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { DEFAULT_SETTINGS, SettingsContext, palette } from './theme'
import { Menu, MenuItem, menuMaxHeight } from './ui'

// GPUIX's test renderer reads frames back from the GPU: macOS and Windows only (see compose.test.tsx).
const rendererSupported = process.platform !== 'linux'
const C = palette('dark', 'red')
let root: TestRoot
beforeEach(() => {
  if (rendererSupported) root = createTestRoot({ width: 900, height: 500 })
})
afterEach(() => {
  if (rendererSupported) root.unmount()
})

test.skipIf(!rendererSupported)('a menu longer than the window stays inside it and scrolls to its last item', () => {
  root.render(
    <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, C, update: () => {} }}>
      <div style={{ width: 900, height: 500, display: 'flex', flexDirection: 'row', justifyContent: 'flex-end' }}>
        <div style={{ width: 30, height: 30, marginTop: 10, marginRight: 20 }}>
          <Menu open onClose={() => {}} align="end" testId="labels-menu">
            {Array.from({ length: 40 }, (_, i) => <MenuItem key={i} label={`Project ${i + 1}`} onSelect={() => {}} testId={`item-${i}`} />)}
          </Menu>
        </div>
      </div>
    </SettingsContext.Provider>,
  )
  root.renderer.flush()
  root.renderer.flush()
  const menu = root.renderer.getElementBounds(root.renderer.findByTestId('labels-menu')!.id)!
  expect(menu.height).toBeLessThanOrEqual(menuMaxHeight(500))
  expect(menu.y).toBeGreaterThanOrEqual(0)
  expect(menu.y + menu.height).toBeLessThanOrEqual(500)
  expect(root.renderer.findByTestId('labels-menu-scroll')).toBeTruthy()
})

test('menus may be as tall as the window less a margin, never vanishingly short', () => {
  expect(menuMaxHeight(900)).toBe(876)
  expect(menuMaxHeight(100)).toBe(120)
})
