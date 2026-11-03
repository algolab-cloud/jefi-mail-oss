import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { useState } from 'react'
import { createTestRoot } from '@gpuix/react/testing'
import { markdownLinkEventsVersion } from '@gpuix/native'
import { MailMarkdown } from '../../src/markdown'
import { DEFAULT_SETTINGS, SettingsContext, palette } from '../../src/theme'

const FIRST_URL = 'https://evil.example/path?token=private'
const SECOND_URL = 'https://two.example/styled'
const SOURCE = [
  `😀 Before [https://trusted.example](${FIRST_URL}) and [**styled** link](${SECOND_URL}) plus a [repeated destination](${SECOND_URL}), with *italic fidelity* and enough text to wrap the destinations across a narrow message column.`,
  '',
  '| Item | Destination |',
  '| --- | --- |',
  '| table | [table link](https://table.example/path) |',
].join('\n')

const settings = { ...DEFAULT_SETTINGS, trustedLinkDomains: [] }
const C = palette(settings.theme, settings.accent)
const opened: string[] = []
let parentKeyDowns = 0

function Fixture() {
  const [lastReviewed, setLastReviewed] = useState<string | null>(null)
  return (
    <SettingsContext.Provider value={{ settings, C, update: () => {} }}>
      <div
        testId="link-event-fixture"
        onKeyDown={() => { parentKeyDowns++ }}
        style={{ width: 520, height: 560, padding: 24, backgroundColor: C.reading }}
      >
        <MailMarkdown
          source={SOURCE}
          testId="native-markdown"
          linkDisclosure={{ sender: 'sender@example.test', trustedDomains: [] }}
          onLink={(url) => {
            opened.push(url)
            setLastReviewed(url)
          }}
        />
        {lastReviewed ? <text testId="review-target">Review: {lastReviewed}</text> : null}
      </div>
    </SettingsContext.Provider>
  )
}

const screenshot = (renderer: ReturnType<typeof createTestRoot>['renderer'], file: string) => {
  const path = resolve(file)
  mkdirSync(dirname(path), { recursive: true })
  renderer.captureScreenshot(path)
}

const subtreeText = (renderer: ReturnType<typeof createTestRoot>['renderer'], elementId: number): string => {
  const element = renderer.getElement(elementId)
  if (!element) return ''
  return [element.text ?? '', ...element.children.map((child) => subtreeText(renderer, child))].join('\n')
}

const focusUntilInlineDisclosure = (renderer: ReturnType<typeof createTestRoot>['renderer'], expectedUrl: string) => {
  for (let step = 1; step <= 12; step++) {
    renderer.simulateKeystrokes('tab')
    renderer.dispatchNativeEvents()
    renderer.flush()
    const disclosure = renderer.findByTestId('message-inline-link-disclosure')
    if (disclosure && subtreeText(renderer, disclosure.id).includes(expectedUrl)) return { disclosure, step }
  }
  return null
}

assert.equal(markdownLinkEventsVersion(), 1, 'the smoke test must use Jefi’s patched native addon')

const originalFetch = globalThis.fetch
let fetchCount = 0
globalThis.fetch = (async () => {
  fetchCount++
  throw new Error('network access is forbidden during link disclosure')
}) as typeof fetch

const app = createTestRoot({
  width: 580,
  height: 620,
  onKeyDown: (event, renderer) => {
    if (event.key !== 'tab' || event.modifiers?.cmd || event.modifiers?.ctrl || event.modifiers?.alt) return
    if (event.modifiers?.shift) renderer.focusPrevious?.()
    else renderer.focusNext?.()
  },
})
try {
  app.render(<Fixture />)
  app.renderer.flush()
  app.renderer.advanceTime(1)
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()

  const markdown = app.renderer.findByTestId('native-markdown')
  assert(markdown, 'native markdown should render')
  const bounds = app.renderer.getElementBounds(markdown.id)
  assert(bounds, 'native markdown should have painted bounds')

  let hoverPoint: { x: number; y: number } | null = null
  for (let y = bounds.y + 5; y < Math.min(bounds.y + bounds.height, bounds.y + 125) && !hoverPoint; y += 5) {
    for (let x = bounds.x + 5; x < bounds.x + bounds.width - 5; x += 5) {
      app.renderer.nativeSimulateMouseMove(x, y)
      const disclosure = app.renderer.findByTestId('message-inline-link-disclosure')
      if (disclosure) {
        if (subtreeText(app.renderer, disclosure.id).includes(FIRST_URL)) {
          hoverPoint = { x, y }
          break
        }
      }
    }
  }
  assert(hoverPoint, 'moving over the inline link should disclose its exact URL')
  assert.equal(fetchCount, 0, 'hover disclosure must not access the network')
  screenshot(app.renderer, 'tmp/markdown-link-hover.png')

  let clearPoint: { x: number; y: number } | null = null
  for (let y = bounds.y + 4; y < bounds.y + bounds.height - 4 && !clearPoint; y += 8) {
    for (let x = bounds.x + bounds.width - 4; x > bounds.x + 4; x -= 8) {
      app.renderer.nativeSimulateMouseMove(x, y)
      if (!app.renderer.findByTestId('message-inline-link-disclosure')) {
        clearPoint = { x, y }
        break
      }
    }
  }
  assert(clearPoint, 'moving to a non-link area inside Markdown should clear stale hover disclosure')

  const firstFocus = focusUntilInlineDisclosure(app.renderer, FIRST_URL)
  assert(firstFocus, 'Tab focus should disclose the first inline destination')
  const firstFocusDisclosure = firstFocus.disclosure
  assert(subtreeText(app.renderer, firstFocusDisclosure.id).includes(FIRST_URL), 'the first focus surface should bind to the first painted link range')
  screenshot(app.renderer, 'tmp/markdown-link-focus.png')

  app.renderer.simulateKeystrokes('enter')
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()
  assert.deepEqual(opened, [FIRST_URL], 'plain Enter should route exactly once through the review callback')
  assert.equal(parentKeyDowns, 0, 'handled link activation should not trigger parent keyboard actions')
  assert(app.renderer.findByTestId('review-target'), 'activation should expose a review target rather than opening externally')

  app.renderer.simulateKeystrokes('cmd-enter')
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()
  assert.deepEqual(opened, [FIRST_URL], 'modified Enter must not activate a link')

  const secondFocus = focusUntilInlineDisclosure(app.renderer, SECOND_URL)
  assert(secondFocus, 'Tab focus should bind to the styled link')
  const secondFocusDisclosure = secondFocus.disclosure
  assert(subtreeText(app.renderer, secondFocusDisclosure.id).includes(SECOND_URL))
  app.renderer.simulateKeystrokes('space')
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()
  assert.deepEqual(opened, [FIRST_URL, SECOND_URL], 'Space should activate the focused styled link exactly once')

  app.renderer.simulateKeystrokes('tab')
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()
  const duplicateForwardDisclosure = app.renderer.findByTestId('message-inline-link-disclosure')
  assert(duplicateForwardDisclosure && subtreeText(app.renderer, duplicateForwardDisclosure.id).includes(SECOND_URL), 'Tab should reach the separate inline link with the repeated destination')

  app.renderer.simulateKeystrokes('shift-tab')
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()
  const reverseDisclosure = app.renderer.findByTestId('message-inline-link-disclosure')
  assert(reverseDisclosure && subtreeText(app.renderer, reverseDisclosure.id).includes(SECOND_URL), 'Shift-Tab between links with the same URL must retain the newly focused disclosure')
  app.renderer.simulateKeystrokes('tab')
  app.renderer.dispatchNativeEvents()
  app.renderer.flush()
  const forwardDisclosure = app.renderer.findByTestId('message-inline-link-disclosure')
  assert(forwardDisclosure && subtreeText(app.renderer, forwardDisclosure.id).includes(SECOND_URL), 'Tab should advance to the repeated destination again')

  const beforeClick = opened.length
  app.renderer.nativeSimulateClick(hoverPoint.x, hoverPoint.y)
  assert.equal(opened.length, beforeClick + 1, 'pointer activation should still route through the existing review callback')
  assert.equal(opened.at(-1), FIRST_URL)

  const selected = app.renderer.dragSelect(bounds.x + 4, bounds.y + 8, bounds.x + bounds.width - 8, bounds.y + 45)
  assert(selected && selected.includes('trusted.example'), 'focus surfaces must not prevent native drag selection across a link')
  screenshot(app.renderer, 'tmp/markdown-link-selection.png')
  assert.equal(fetchCount, 0, 'focus, keyboard activation, click review, and selection must not fetch a destination')

  console.log(JSON.stringify({
    marker: markdownLinkEventsVersion(),
    focusSteps: [firstFocus.step, secondFocus.step],
    opened,
    selected,
    fetchCount,
    screenshots: ['tmp/markdown-link-hover.png', 'tmp/markdown-link-focus.png', 'tmp/markdown-link-selection.png'],
  }, null, 2))
} finally {
  app.unmount()
  globalThis.fetch = originalFetch
}
