import { createTestRoot } from '@gpuix/react/testing'
import { expect, mock } from 'bun:test'
import { DEFAULT_SETTINGS, SettingsContext, palette } from '../../src/theme'

let googleConfigured = false
let googleCalls = 0
mock.module('../../src/web-risk-key', () => ({
  useWebRiskKey: () => ({ key: googleConfigured ? 'fixture-key' : null, loaded: true, error: null, configured: googleConfigured }),
}))
mock.module('../../src/web-risk', () => ({
  WebRiskError: class FixtureWebRiskError extends Error {},
  checkWebRiskUrl: async () => {
    googleCalls++
    return { kind: 'threat', threatTypes: ['SOCIAL_ENGINEERING'], expiresAt: Date.now() + 60_000, source: 'google' }
  },
}))
mock.module('../../src/use-phishing-database', () => ({
  usePhishingDatabase: (enabled = false) => ({
    status: null,
    check: (url: string) => enabled && url.includes('reported.example')
      ? { hit: true, type: 'domain', source: 'Phishing.Database', matched: 'reported.example', updatedAt: Date.now(), stale: false }
      : null,
    update: async () => {},
  }),
}))

const { LinkPopover } = await import('../../src/link-popover')
const viewport = { width: 900, height: 700 }
const root = createTestRoot(viewport)
const opened: string[] = []
const copied: string[] = []
let closed = 0

const render = (raw: string, position: { x: number; y: number }, options: { phishingListEnabled?: boolean; google?: boolean } = {}) => {
  googleConfigured = Boolean(options.google)
  root.render(
    <SettingsContext.Provider value={{ settings: { ...DEFAULT_SETTINGS, phishingListEnabled: Boolean(options.phishingListEnabled) }, C: palette('dark', 'red'), update: () => {} }}>
      <div style={{ width: viewport.width, height: viewport.height }}>
        <LinkPopover
          key={`${raw}:${position.x}:${position.y}:${options.phishingListEnabled}:${options.google}`}
          raw={raw}
          sender="sender@harbor.io"
          trustedDomains={[]}
          position={position}
          onClose={() => { closed++ }}
          onOpen={(url) => opened.push(url)}
          onCompose={() => {}}
          onCopy={(url) => copied.push(url)}
        />
      </div>
    </SettingsContext.Provider>,
  )
  root.renderer.flush()
}

const click = (testId: string) => {
  const node = root.renderer.findByTestId(testId)
  if (!node) throw new Error(`Missing ${testId}`)
  const bounds = root.renderer.getElementBounds(node.id)!
  root.renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  root.renderer.dispatchNativeEvents()
  root.renderer.flush()
}

try {
  const raw = 'https://billing.example.net/pay?private-token=abcdefghijklmnopqrstuvwxyz0123456789'
  render(raw, { x: 895, y: 695 })
  const popover = root.renderer.findByTestId('link-review-popover')!
  const bounds = root.renderer.getElementBounds(popover.id)!
  expect(bounds.width).toBeLessThanOrEqual(320)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
  expect(root.renderer.getAllText()).not.toContain('Add a Google Web Risk API key')
  expect(root.renderer.findByTestId('link-review-database-unavailable')).toBeUndefined()
  root.renderer.captureScreenshot(`${process.cwd()}/tmp/link-popover-compact-edge.png`)

  click('link-review-copy')
  expect(copied).toEqual([raw])
  expect(opened).toEqual([])

  render('https://billing.example.net/private?token=secret', { x: 895, y: 695 }, { google: true })
  const googleBounds = root.renderer.getElementBounds(root.renderer.findByTestId('link-review-popover')!.id)!
  expect(googleBounds.x + googleBounds.width).toBeLessThanOrEqual(viewport.width)
  expect(googleBounds.y + googleBounds.height).toBeLessThanOrEqual(viewport.height)
  expect(root.renderer.getAllText().join(' ')).toContain('including private tokens')
  expect(root.renderer.findByTestId('link-review-google-check')).toBeDefined()
  root.renderer.captureScreenshot(`${process.cwd()}/tmp/link-popover-compact-google.png`)

  render('https://harbor.io/private?token=secret', { x: 895, y: 695 }, { google: true })
  expect(root.renderer.getAllText()).toContain('Open link')
  click('link-review-google-check')
  await Bun.sleep(0)
  root.renderer.flush()
  root.renderer.flush()
  expect(googleCalls).toBe(1)
  expect(root.renderer.findByTestId('link-review-google-threat')).toBeDefined()
  expect(root.renderer.findByTestId('link-review-google-advisory')).toBeDefined()
  expect(root.renderer.getAllText()).toContain('Open anyway')
  const threatBounds = root.renderer.getElementBounds(root.renderer.findByTestId('link-review-popover')!.id)!
  expect(threatBounds.x + threatBounds.width).toBeLessThanOrEqual(viewport.width)
  expect(threatBounds.y + threatBounds.height).toBeLessThanOrEqual(viewport.height)
  root.renderer.captureScreenshot(`${process.cwd()}/tmp/link-popover-compact-google-threat.png`)

  render('https://reported.example/login', { x: 450, y: 350 }, { phishingListEnabled: true })
  expect(root.renderer.findByTestId('link-review-database-threat')).toBeDefined()
  expect(root.renderer.getAllText()).toContain('Open anyway')
  expect(root.renderer.findByTestId('link-review-warning-1')).toBeUndefined()
  expect(root.renderer.getAllText().join(' ')).toContain("does not match the sender's domain")
  root.renderer.captureScreenshot(`${process.cwd()}/tmp/link-popover-compact-threat.png`)
  click('link-review-warnings-toggle')
  expect(root.renderer.findByTestId('link-review-warning-1')).toBeDefined()
  expect(root.renderer.getAllText().join(' ')).toContain('does not use a recognized public website domain')
  click('link-review-cancel')
  expect(opened).toEqual([])

  render('javascript:alert(1)', { x: 895, y: 695 })
  expect(root.renderer.findByTestId('link-review-open')).toBeUndefined()
  click('link-review-cancel')
  expect(opened).toEqual([])
  expect(closed).toBe(3)
  console.log('LINK_POPOVER_COMPACT_PASS', JSON.stringify({ edgeBounds: bounds, copied: copied.length }))
} finally {
  root.unmount()
}
process.exit(0)
