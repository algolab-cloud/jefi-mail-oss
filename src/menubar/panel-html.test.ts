import { describe, expect, test } from 'bun:test'
import { palette } from '../theme'
import { buildMenuBarModel } from './model'
import { escapeHtml, GLASS_SCRIM, GLASS_WORST, menuBarBody, menuBarHtml, panelInk, SOLID_SURFACE } from './panel-html'

const now = new Date(2026, 8, 26, 10, 0).getTime()
const model = buildMenuBarModel({
  now,
  unread: 7,
  colorOf: () => '#3E63DD',
  firstDay: 1,
  occurrences: [{ key: 'k1', title: '<img src=x onerror=alert(1)>', startAt: now + 25 * 60_000, endAt: now + 40 * 60_000, allDay: false, calendarId: 'c', location: 'Zoom' }],
  recent: [{ id: 'r1', kind: 'mail', title: 'Lea "Ortiz"', detail: 'Q3 review', at: now - 120_000, route: { type: 'thread', accountId: 'a', threadId: 't' } }],
  pendingInvites: [{ eventId: 'e1', title: 'Offsite', start: now + 86_400_000, allDay: false, organizer: 'Mira' }],
  tasks: [{ id: 'task-1', title: 'Send <the> deck', due: 'Yesterday', overdue: true }],
})
const glass = { accent: palette('dark', 'violet').accent, glass: true }
const light = { accent: palette('light', 'blue').accent, glass: false }

describe('menuBarHtml', () => {
  const html = menuBarHtml(model, light, 'abc123')
  test('has every section and action', () => {
    for (const part of ['Up next', 'Today', 'Recent', 'Invitations', 'id="quick"', 'data-action="compose"', 'data-action="new-event"', 'data-action="new-note"', 'data-action="new-task"', 'data-action="toggle-task"', 'data-action="open-task"', 'Tasks', 'data-action="open-jefi"', 'data-action="settings"', 'data-action="quit"', 'data-action="open-day"']) {
      expect(html).toContain(part)
    }
  })
  test('quick add stops at what the app accepts, so a long entry is never silently dropped', () => {
    // parsePanelMessage refuses arguments over 500 characters, after the field has been cleared.
    expect(html).toMatch(/<input name="text" maxlength="500"/)
  })
  test('escapes mail and calendar text', () => {
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Lea &quot;Ortiz&quot;')
    expect(html).toContain('Send &lt;the&gt; deck')
    expect(html).toContain('class="due late"')
  })
  test('a tight policy: only the nonce-tagged script, nothing remote', () => {
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'nonce-abc123'")
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain('<script nonce="abc123">')
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/)
  })
  test('carries the live countdown and the accent, and follows the system appearance', () => {
    expect(html).toContain('in 25m')
    expect(html).toContain(`--accent:${light.accent}`)
    expect(html).toContain('color-scheme:light dark')
    expect(html).toContain('@media (prefers-color-scheme:dark)')
  })
  test('a light wash over glass, its own surface before macOS 26', () => {
    expect(menuBarHtml(model, glass, 'n')).toContain('body{background:var(--scrim)}')
    expect(html).toContain('body{background:var(--surface)}')
  })
  test('a hostile nonce cannot break out of the policy', () => expect(menuBarHtml(model, light, `x' 'unsafe-inline`)).toContain("'nonce-xunsafe-inline'"))
  test('the body swapped in while open matches the page', () => expect(html).toContain(menuBarBody(model, light)))
  test('empty feeds say so and drop the invitations', () => {
    const quiet = menuBarBody({ ...model, recent: [], pendingInvites: [], upNext: null, today: [] }, glass)
    expect(quiet).toContain('No new notifications')
    expect(quiet).toContain('Nothing scheduled')
    expect(quiet).not.toContain('Invitations')
  })
  test('escapeHtml', () => expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;'))
})

// WCAG contrast of the label colours over what sits behind them: on macOS 26+ the page's wash over
// the glass at its worst (the opposite backdrop), before that the page's surface over black or white.
type Rgb = [number, number, number]
const hex = (value: string): Rgb => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb
const over = ([r, g, b, a]: [number, number, number, number], [br, bg, bb]: Rgb): Rgb => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

describe('panel contrast', () => {
  for (const look of ['light', 'dark'] as const) {
    const ink = Object.values(panelInk(look === 'dark'))
    test(`${look} on glass over the worst backdrop: text, secondary and muted reach AA`, () => {
      const tint = over(GLASS_SCRIM[look], hex(GLASS_WORST[look]))
      for (const colour of ink) expect(contrast(over(colour, tint), tint)).toBeGreaterThanOrEqual(4.5)
    })
    for (const backdrop of ['#000000', '#FFFFFF']) {
      test(`${look} on the pre-glass surface over ${backdrop}: AA`, () => {
        const { color, alpha } = SOLID_SURFACE[look]
        const bg = over([...hex(color), alpha], hex(backdrop))
        for (const colour of ink) expect(contrast(over(colour, bg), bg)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
