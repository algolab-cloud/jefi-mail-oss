/**
 * Builds the pictures that show up when jefi.app is shared — in Messages, Slack, a search result,
 * anywhere a link is unfurled: one for the home page (both apps), one for /mail and one for /shot.
 * Each sets its headline beside 3D art made with Codex (brand/og/*-art.jpg), faded into the background.
 *
 *   bun run og
 *
 * Writes ../website/public/og.png, og-mail.png and og-shot.png at 1200×630, the size every platform crops from.
 */
import { Resvg } from '@resvg/resvg-js'
import { WEBSITE } from './website-dir'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const WIDTH = 1200
const HEIGHT = 630

/** The site's own colours, so a shared link looks like the page it opens. */
const INK = '#F5F3EF'
const MUTED = '#9B99A8'
const BACKGROUND = '#09090C'
const VIOLET = '#8B5CF6'
const VIOLET_SOFT = '#B9A4FB'
const CORAL = '#FF7A6B'
const CORAL_SOFT = '#FFB2A6'

/** Artwork lifted straight from the brand kit so it can never drift from the app's, `width` wide. */
function brand(file: string, x: number, y: number, width: number): string {
  const source = readFileSync(`${ROOT}/brand/${file}`, 'utf8')
  const inner = source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))
  const [, , drawnWidth] = source.match(/viewBox="([^"]+)"/)![1]!.split(' ').map(Number)
  return `<g transform="translate(${x} ${y}) scale(${width / drawnWidth!})" opacity="0.98">${inner}</g>`
}

const FONT = 'Helvetica Neue, Helvetica, Arial'

type Card = {
  out: string
  art: string
  glow: string
  kicker: string
  accent: string
  lines: [string, string]
  sub: [string, string]
  /** The pill under the copy: what it costs. */
  pill: string
  /** Headline size; a long second line gets a smaller one so it clears the art. */
  size?: number
  /** Where the art starts, if this card's subject needs more room on the left. */
  artX?: number
}

/** One share card: the lockup and headline on the left, the art on the right fading in behind them. */
function card({ art, glow, kicker, accent, lines, sub, pill, size = 64, artX = 410 }: Card): string {
  // Sized to its text: about 10.8 px a character at 22 px, plus the padding either side.
  const pillWidth = Math.round(pill.length * 10.8 + 56)
  const image = `data:image/jpeg;base64,${readFileSync(`${ROOT}/brand/og/${art}`).toString('base64')}`
  // The art is 3:2 with its subject a little right of centre; drawn 780 wide from x = 410, it sits whole at the right.
  const artWidth = 780
  const artHeight = 520
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <!-- An oval fade, so the art's own background melts into the page on every side. -->
    <radialGradient id="fade" cx="${artX + artWidth * 0.56}" cy="${HEIGHT / 2}" r="${artWidth * 0.5}" gradientTransform="translate(${artX + artWidth * 0.56} ${HEIGHT / 2}) scale(1 0.72) translate(${-(artX + artWidth * 0.56)} ${-HEIGHT / 2})" gradientUnits="userSpaceOnUse">
      <stop offset="0.62" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <mask id="soft"><rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#fade)"/></mask>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${glow}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BACKGROUND}"/>
  <circle cx="860" cy="315" r="320" fill="url(#glow)"/>
  <image x="${artX}" y="${(HEIGHT - artHeight) / 2}" width="${artWidth}" height="${artHeight}" xlink:href="${image}" mask="url(#soft)" preserveAspectRatio="xMidYMid slice"/>

  ${brand('logo/jefi-logo-white.svg', 72, 62, 118)}

  <text x="72" y="214" fill="${accent}" font-family="${FONT}" font-size="20" font-weight="600" letter-spacing="3">${kicker}</text>
  <text x="72" y="290" fill="${INK}" font-family="${FONT}" font-size="${size}" font-weight="600" letter-spacing="-2.2">${lines[0]}</text>
  <text x="72" y="364" fill="${accent}" font-family="${FONT}" font-size="${size}" font-weight="600" letter-spacing="-2.2">${lines[1]}</text>

  <text x="72" y="436" fill="${MUTED}" font-family="${FONT}" font-size="25" letter-spacing="-0.3">${sub[0]}</text>
  <text x="72" y="472" fill="${MUTED}" font-family="${FONT}" font-size="25" letter-spacing="-0.3">${sub[1]}</text>

  <rect x="72" y="516" width="${pillWidth}" height="52" rx="26" fill="#FFFFFF" fill-opacity="0.06" stroke="#FFFFFF" stroke-opacity="0.14"/>
  <text x="100" y="549" fill="${INK}" font-family="${FONT}" font-size="22" font-weight="500">${pill}</text>
  <text x="${72 + pillWidth + 34}" y="549" fill="${MUTED}" font-family="${FONT}" font-size="22">jefi.app</text>
</svg>`
}

const cards: Array<Card> = [
  {
    out: 'og.png',
    art: 'og-home-art.jpg',
    glow: VIOLET,
    kicker: 'JEFI · APPS FOR YOUR MAC',
    accent: VIOLET_SOFT,
    lines: ['Quiet, private apps', 'for your Mac.'],
    sub: ['Jefi Mail keeps every inbox private. Jefi Shot', 'turns a screen recording into a polished demo.'],
    pill: 'Mail is free · Shot is pay once',
  },
  {
    out: 'og-mail.png',
    art: 'og-mail-art.jpg',
    glow: VIOLET,
    kicker: 'JEFI MAIL',
    accent: VIOLET_SOFT,
    lines: ['Your inbox is', 'nobody else’s business.'],
    size: 56,
    artX: 470,
    sub: ['Mail, calendar, notes and tasks for macOS,', 'straight between your Mac and your provider.'],
    pill: 'Free · open source',
  },
  {
    out: 'og-shot.png',
    art: 'og-shot-art.jpg',
    glow: CORAL,
    kicker: 'JEFI SHOT',
    accent: CORAL_SOFT,
    lines: ['Demo videos,', 'without the editing.'],
    sub: ['Record a window, get a polished take: zooms,', 'a smooth cursor, a clean frame. Nothing uploaded.'],
    pill: 'Pay once · 14 days free',
  },
]

for (const c of cards) {
  const png = new Resvg(card(c), {
    fitTo: { mode: 'width', value: WIDTH },
    background: BACKGROUND,
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' },
  }).render()
  const out = `${WEBSITE}/public/${c.out}`
  writeFileSync(out, png.asPng())
  console.log(`wrote ${out} (${WIDTH}×${HEIGHT}, ${(png.asPng().length / 1024).toFixed(0)} KB)`)
}
