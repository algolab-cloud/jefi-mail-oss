import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, test } from 'bun:test'
import { clipAround, hasRemoteImages, maxPageHeight, pageHeight } from './html-view'
import { imageSources, linkPositionFromWindowPoint, mailBackground, mailPage, takesTheme, mailViewHidden, navigationPolicy, snapshotBoundsAllowed, snapshotIdentityMatches, stripSpeculativeLinks } from './native/mail-webview'
import { DEFAULT_SETTINGS, allowRemoteImagesFrom, forgetRemoteImageSender, loadSettings, remoteImagesAllowed, saveSettings } from './theme'

const clip = { x: 1000, y: 100, width: 900, height: 1000 }

test('the web view keeps the larger clear side of a floating box', () => {
  // Chat box over the bottom-right corner: more room beside it than above it.
  expect(clipAround(clip, { x: 1500, y: 500, width: 400, height: 600 })).toEqual({ x: 1000, y: 100, width: 500, height: 1000 })
  // A wide, short box along the bottom: keep what's above.
  expect(clipAround(clip, { x: 1100, y: 900, width: 800, height: 200 })).toEqual({ x: 1000, y: 100, width: 900, height: 800 })
})

test('no box, or one that misses the reader, changes nothing', () => {
  expect(clipAround(clip, null)).toBe(clip)
  expect(clipAround(clip, { x: 0, y: 0, width: 400, height: 600 })).toBe(clip)
})

test('a box covering the whole reader leaves nothing to show', () => {
  const left = clipAround(clip, { x: 900, y: 0, width: 1200, height: 1300 })
  expect(Math.max(left.width, 0) * Math.max(left.height, 0)).toBe(0)
})

test('native HTML link clicks use the actual mouse point in GPUI coordinates', () => {
  expect(linkPositionFromWindowPoint(2, 900, 200, 1000)).toEqual({ x: 908, y: 812 })
  expect(linkPositionFromWindowPoint(1, 20.5, 950.5, 1000)).toEqual({ x: 28.5, y: 61.5 })
  // Keyboard activation has no mouse anchor and keeps the component's deterministic fallback.
  expect(linkPositionFromWindowPoint(10, 900, 200, 1000)).toBeNull()
  expect(linkPositionFromWindowPoint(2, Number.NaN, 200, 1000)).toBeNull()
})

test('the frozen HTML canvas has a bounded finite allocation', () => {
  expect(snapshotBoundsAllowed(1440, 900)).toBe(true)
  expect(snapshotBoundsAllowed(2000, 2000)).toBe(true)
  expect(snapshotBoundsAllowed(2001, 2000)).toBe(false)
  expect(snapshotBoundsAllowed(0, 900)).toBe(false)
  expect(snapshotBoundsAllowed(Number.NaN, 900)).toBe(false)
  expect(snapshotBoundsAllowed(8192, 8192)).toBe(false)
})

test('a native snapshot cannot cross a page, navigation, view, or visibility change', () => {
  const web = 1 as never
  const navigation = 2 as never
  const requested = { generation: 4, web, page: 'page-a', navigation }
  const current = { ...requested, loadedPage: 'page-a', placed: true }
  expect(snapshotIdentityMatches(requested, current)).toBe(true)
  expect(snapshotIdentityMatches(requested, { ...current, generation: 5 })).toBe(false)
  expect(snapshotIdentityMatches(requested, { ...current, page: 'page-b' })).toBe(false)
  expect(snapshotIdentityMatches(requested, { ...current, navigation: 3 as never })).toBe(false)
  expect(snapshotIdentityMatches(requested, { ...current, web: 4 as never })).toBe(false)
  expect(snapshotIdentityMatches(requested, { ...current, loadedPage: '' })).toBe(false)
  expect(snapshotIdentityMatches(requested, { ...current, placed: false })).toBe(false)
})

test('an open overlay hides the web view whether or not a snapshot exists (lume-s00)', () => {
  const base = { placed: true, overlays: true, linkReviewBesideWeb: false, capturingOnScreen: false }
  // First placement, a new page, or a failed capture under an open sheet: never drawn over it.
  expect(mailViewHidden(base)).toBe(true)
  // Only a capture started while on screen keeps it up, until its image has painted.
  expect(mailViewHidden({ ...base, capturingOnScreen: true })).toBe(false)
  // A link review whose capture failed sits beside the live view on purpose.
  expect(mailViewHidden({ ...base, linkReviewBesideWeb: true })).toBe(false)
  expect(mailViewHidden({ ...base, overlays: false })).toBe(false)
  expect(mailViewHidden({ ...base, overlays: false, placed: false })).toBe(true)
})

// ---------------------------------------------------------------------------
// Remote images
// ---------------------------------------------------------------------------

test('every way a message can ask for an image off the network is spotted', () => {
  expect(hasRemoteImages('<img src="https://track.example/pixel.gif?id=1">')).toBe(true)
  expect(hasRemoteImages('<img src=http://track.example/p.gif>')).toBe(true)
  // Protocol-relative: the renderer would fetch it just the same.
  expect(hasRemoteImages('<img src="//track.example/x.gif">')).toBe(true)
  expect(hasRemoteImages('<img srcset="a.png 1x, https://cdn.example/b.png 2x">')).toBe(true)
  expect(hasRemoteImages('<td background="https://cdn.example/tile.png">')).toBe(true)
  expect(hasRemoteImages('<div style="background-image:url(https://cdn.example/hero.jpg)">')).toBe(true)
  expect(hasRemoteImages("<div style=\"background:url('//cdn.example/hero.jpg')\">")).toBe(true)
  // Case and whitespace are the sender's to choose.
  expect(hasRemoteImages('<IMG SRC = " HTTPS://TRACK.EXAMPLE/P.GIF ">')).toBe(true)
  expect(hasRemoteImages('<div style="background:URL(  http://cdn.example/x.png  )">')).toBe(true)
})

test('mail that carries its own images has nothing to hide', () => {
  expect(hasRemoteImages('<img src="data:image/gif;base64,R0lGOD">')).toBe(false)
  expect(hasRemoteImages('<img src="cid:logo@example">')).toBe(false)
  expect(hasRemoteImages('<img srcset="cid:a@x 1x, cid:b@x 2x">')).toBe(false)
  expect(hasRemoteImages('<p>Plain words and an <a href="https://example.com">https link</a>.</p>')).toBe(false)
  expect(hasRemoteImages('')).toBe(false)
})

test('the image policy blocks the network by default and never allows plain http', () => {
  expect(imageSources(false)).toBe('data: cid:')
  expect(imageSources(false)).not.toContain('http')
  expect(imageSources(true)).toContain('https:')
  expect(imageSources(true).split(' ')).not.toContain('http:')
})

test('remote images are allowed per sender, whatever the case of the address', () => {
  const blocked = { ...DEFAULT_SETTINGS }
  expect(remoteImagesAllowed(blocked, 'news@example.com')).toBe(false)
  const allowed = { ...blocked, remoteImageSenders: allowRemoteImagesFrom(blocked, ' News@Example.COM ') }
  expect(allowed.remoteImageSenders).toEqual(['news@example.com'])
  expect(remoteImagesAllowed(allowed, 'NEWS@example.com')).toBe(true)
  expect(remoteImagesAllowed(allowed, 'other@example.com')).toBe(false)
  // Allowing the same sender twice doesn't grow the list.
  expect(allowRemoteImagesFrom(allowed, 'NEWS@EXAMPLE.COM')).toEqual(['news@example.com'])
  // Showing everyone's images skips the list entirely.
  expect(remoteImagesAllowed({ ...blocked, remoteImages: 'always' }, 'other@example.com')).toBe(true)
})

test('an allowed sender can be forgotten again', () => {
  const settings = { ...DEFAULT_SETTINGS, remoteImageSenders: ['news@example.com', 'shop@example.com'] }
  expect(forgetRemoteImageSender(settings, ' NEWS@Example.com ')).toEqual(['shop@example.com'])
  expect(remoteImagesAllowed({ ...settings, remoteImageSenders: forgetRemoteImageSender(settings, 'news@example.com') }, 'news@example.com')).toBe(false)
  // Someone who was never allowed leaves the list as it was.
  expect(forgetRemoteImageSender(settings, 'stranger@example.com')).toBe(settings.remoteImageSenders)
  expect(forgetRemoteImageSender(DEFAULT_SETTINGS, 'news@example.com')).toEqual([])
})

test('links that would resolve a hostname before anything is shown are dropped', () => {
  expect(stripSpeculativeLinks('<link rel="dns-prefetch" href="https://t.example">')).toBe('')
  expect(stripSpeculativeLinks("<link rel='preconnect' href='https://t.example'>")).toBe('')
  expect(stripSpeculativeLinks('<link rel=prefetch href=https://t.example>')).toBe('')
  expect(stripSpeculativeLinks('<LINK REL = "PRELOAD" AS="image" HREF="https://t.example/p.gif">')).toBe('')
  expect(stripSpeculativeLinks('<link rel="prerender" href="https://t.example">')).toBe('')
  // One rel can carry several tokens.
  expect(stripSpeculativeLinks('<link rel="preconnect dns-prefetch" href="https://t.example">')).toBe('')
  expect(stripSpeculativeLinks('<p>a</p><link rel="dns-prefetch" href="https://t.example"><p>b</p>')).toBe('<p>a</p><p>b</p>')
})

test('the rest of the message, links included, is left as it was', () => {
  const html = '<link rel="stylesheet" href="https://cdn.example/x.css"><p>Read <a href="https://example.com/post">the post</a>.</p>'
  expect(stripSpeculativeLinks(html)).toBe(html)
  expect(stripSpeculativeLinks('<link href="https://cdn.example/x.css">')).toBe('<link href="https://cdn.example/x.css">')
  expect(stripSpeculativeLinks('<p>Nothing to strip · preload, preconnect.</p>')).toBe('<p>Nothing to strip · preload, preconnect.</p>')
})

test('full HTML discloses link destinations on hover and keyboard focus without executable UI code', () => {
  const page = mailPage('<a href="https://different.example/path">Visible label</a>', false)
  expect(page).toContain('a[href]:hover::after,a[href]:focus::after')
  expect(page).toContain('content:"Destination: " attr(href)!important')
  expect(page).toContain("default-src 'none'")
  expect(page).not.toContain('<script')
  expect(page).not.toContain('http-equiv="refresh"')
})

test('the allow list survives a restart', () => {
  const previous = process.env.JEFI_CONFIG_DIR
  const dir = mkdtempSync(`${tmpdir()}/jefi-images-`)
  process.env.JEFI_CONFIG_DIR = dir
  try {
    saveSettings({ ...DEFAULT_SETTINGS, remoteImageSenders: ['News@Example.com'] })
    const loaded = loadSettings()
    expect(loaded.remoteImages).toBe('ask')
    expect(loaded.remoteImageSenders).toEqual(['news@example.com'])
    expect(remoteImagesAllowed(loaded, 'news@EXAMPLE.com')).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.JEFI_CONFIG_DIR
    else process.env.JEFI_CONFIG_DIR = previous
  }
})

test('the content policy leads the page, whatever comes before or looks like a head', () => {
  const policyFirst = /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/i
  // An image ahead of the message's own <head>, a <header> element and no head at all: each once
  // loaded remote images unasked, because the policy landed where WebKit ignores it.
  for (const html of [
    '<img src="https://track.example/a.gif"><html><head><title>x</title></head><body>hi</body></html>',
    '<html><body><header><h1>News</h1></header><img src="https://track.example/b.gif"></body></html>',
    '<p>Just a fragment</p>',
    '<html><head><style>h1{color:red}</style></head><body><h1>Hi</h1></body></html>',
  ]) {
    const page = mailPage(html, false)
    expect(page).toMatch(policyFirst)
    expect(page.match(/Content-Security-Policy/g)).toHaveLength(1)
    // The message follows the policy untouched.
    expect(page).toContain(html)
  }
  // A message's own doctype stays first, so it renders in the mode it asked for.
  const legacy = mailPage('<!-- sent by X --> <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html><head></head><body>x</body></html>', false)
  expect(legacy.startsWith('<!-- sent by X --> <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true)
  expect(mailPage('<!-- a - b --->\n<!doctype html><p>x', false).startsWith('<!-- a - b --->\n<!doctype html><html><head><meta')).toBe(true)
})

test('a message made of empty comments is placed quickly', () => {
  // Once a crafted message: the leading-doctype pattern backtracked exponentially on it.
  const started = performance.now()
  const page = mailPage(`<!--${'--><!--'.repeat(5000)}`, false)
  expect(performance.now() - started).toBeLessThan(500)
  expect(page.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true)
})

test('links to a spot in the message scroll there; other links go to review, other loads stop', () => {
  expect(navigationPolicy('about:blank', false)).toBe('allow')
  expect(navigationPolicy('about:blank#pricing', true)).toBe('allow')
  expect(navigationPolicy('about:blank#pricing', false)).toBe('cancel')
  expect(navigationPolicy('https://example.com/#pricing', true)).toBe('review')
  expect(navigationPolicy('https://tracker.example/pixel.gif', false)).toBe('cancel')
})

const dark = { dark: true, background: '#151517', text: '#ECECEE', link: '#E5484D' }
const light = { dark: false, background: '#FFFFFF', text: '#111113', link: '#E5484D' }

test('plain HTML mail takes the theme; mail with its own backgrounds keeps its white page', () => {
  const plain = '<p style="color:#222">Please confirm the <b>KRA</b> classifications.</p>'
  expect(takesTheme(plain)).toBe(true)
  expect(takesTheme('<div style="background-color: transparent">x</div>')).toBe(true)
  for (const designed of ['<table bgcolor="#f4f4f4"><tr><td>x</td></tr></table>', '<div style="background:#fff">x</div>', '<style>body{background-color:white}</style>x', '<td background="cid:bg">x</td>'])
    expect(takesTheme(designed)).toBe(false)

  const page = mailPage(plain, false, dark)
  expect(page).toContain('<meta name="color-scheme" content="dark">')
  // In the head, ahead of the message, and the colours last, after the message's own styles.
  expect(page.indexOf('color-scheme')).toBeLessThan(page.indexOf('<p style'))
  expect(page.indexOf('jefi-theme')).toBeGreaterThan(page.indexOf('<p style'))
  expect(page).toContain('html,body{background:#151517!important;color:#ECECEE!important}')
  expect(page).toContain('body *{color:inherit!important}')
  expect(mailBackground(plain, dark)).toBe('#151517')

  // Light: the page and default text follow the theme, the sender's text colours stay.
  expect(mailPage(plain, false, light)).not.toContain('color:inherit')
  // Designed mail, or no theme at all: the page as before.
  const designed = '<table bgcolor="#f4f4f4"><tr><td>x</td></tr></table>'
  expect(mailPage(designed, false, dark)).toBe(mailPage(designed, false))
  expect(mailPage(designed, false)).toContain('<meta name="color-scheme" content="light">')
  expect(mailPage(designed, false)).not.toContain('jefi-theme')
  expect(mailBackground(designed, dark)).toBe('#FFFFFF')
})

test('theme colours that are not plain hex never reach the page style sheet', () => {
  const page = mailPage('<p>x</p>', false, { ...dark, background: 'red}</style><script>x</script>', text: '#ECECEE' })
  expect(page).not.toContain('<script>')
  expect(page).toContain('background:#FFFFFF!important')
})

test('the page is as tall as the message once measured, within what a snapshot can cover', () => {
  expect(pageHeight(null, 600, 700)).toBe(600)
  expect(pageHeight(240, 600, 700)).toBe(240)
  expect(pageHeight(10, 600, 700)).toBe(48)
  expect(pageHeight(90_000, 600, 700)).toBe(maxPageHeight(700))
  expect(maxPageHeight(700) * 700).toBeLessThanOrEqual(4_000_000)
  expect(maxPageHeight(300)).toBe(8000)
  expect(snapshotBoundsAllowed(700, maxPageHeight(700))).toBe(true)
})


test('a page that scrolls shows it: a lasting scroll bar, and a fade in the page colour while more is below', () => {
  const plain = mailPage('<p>Long plan</p>', false, dark)
  expect(plain).toContain('::-webkit-scrollbar-thumb')
  expect(plain).toContain('html.jefi-scrolls body::after')
  expect(plain).toContain('linear-gradient(#15151700,#151517)')
  // Designed mail keeps its white page, so its fade is white too.
  expect(mailPage('<table bgcolor="#f4f4f4"><tr><td>x</td></tr></table>', false, dark)).toContain('linear-gradient(#FFFFFF00,#FFFFFF)')
})
