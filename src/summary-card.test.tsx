import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { DEFAULT_SETTINGS, SettingsContext, palette } from './theme'
import { SummaryCard, type CardSummary } from './summary-card'
import type { Handoff } from './assistant-handoff'

// GPUIX's test renderer reads frames back from the GPU: macOS and Windows only (see compose.test.tsx).
const rendererSupported = process.platform !== 'linux'
const C = palette('dark', 'red')
const TEXT = 'Wells of Life’s Uganda meter order is on hold while the team finds a prepaid solution.\n\n- Christine proposed borehole and kiosk metering.\n- Nmwin will check mWater.'

let root: TestRoot
let copied: string[]
let asked: Handoff[]
beforeEach(() => {
  copied = []
  asked = []
  if (rendererSupported) root = createTestRoot({ width: 640, height: 400 })
})
afterEach(() => {
  if (rendererSupported) root.unmount()
})

const render = (summary: CardSummary, subject = 'Uganda meters') => {
  root.render(
    <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, C, update: () => {} }}>
      <div style={{ width: 640, display: 'flex', flexDirection: 'column' }}>
        <SummaryCard provider="ChatGPT" subject={subject} summary={summary} onClose={() => {}} onRetry={() => {}} onCopy={(text) => copied.push(text)} onAsk={(item) => asked.push(item)} />
      </div>
    </SettingsContext.Provider>,
  )
  root.renderer.flush()
}
const bounds = (testId: string) => {
  const node = root.renderer.findByTestId(testId)
  if (!node) throw new Error(`missing ${testId}`)
  return root.renderer.getElementBounds(node.id)!
}
const click = (testId: string) => {
  const b = bounds(testId)
  root.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2)
  root.renderer.dispatchNativeEvents()
  root.renderer.flush()
}

describe.skipIf(!rendererSupported)('SummaryCard', () => {
  test('the title is one line, above the summary rather than over it', () => {
    render({ kind: 'summary', text: TEXT, state: 'done' })
    const title = bounds('ai-summary-title')
    expect(title.height).toBeLessThanOrEqual(26)
    expect(title.y + title.height).toBeLessThanOrEqual(bounds('ai-summary-text').y)
  })

  test('a finished summary can be copied or taken to the chat', () => {
    render({ kind: 'summary', text: TEXT, state: 'done' })
    click('ai-summary-copy')
    expect(copied).toEqual([TEXT])
    click('ai-summary-chat')
    expect(asked).toEqual([{ title: 'Summary of “Uganda meters”', text: TEXT }])
  })

  test('nothing to copy or ask about while it streams or after it failed', () => {
    render({ kind: 'summary', text: 'Wells of', state: 'streaming' })
    expect(root.renderer.findByTestId('ai-summary-copy')).toBeFalsy()
    expect(root.renderer.findByTestId('ai-summary-chat')).toBeFalsy()
    render({ kind: 'translation', text: '', state: 'error', error: 'Rate limit' })
    expect(root.renderer.findByTestId('ai-summary-copy')).toBeFalsy()
    expect(root.renderer.findByTestId('ai-summary-retry')).toBeTruthy()
  })
})
