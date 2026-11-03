/**
 * Tweet images from the marketing screenshots (scripts/shot-marketing.ts): each shot framed as a
 * window on the site's dark, violet-lit background at 16:9, the shape X shows uncropped in a
 * timeline. Two layouts: "wide" puts a headline over the whole app and lets the window run off the
 * bottom; "split" sets the headline beside a close crop of the part the post is about.
 *
 * Every image is written twice: <name>.png with the headline and <name>-clean.png without it, for
 * posts whose text already says it.
 *
 *   bun scripts/shot-marketing.ts tmp/tweets-src --theme=dark --accent=violet
 *   bun scripts/tweet-images.ts [prefix] [outdir]
 *
 * Writes output/tweets/ by default, 2400×1350 (1600×900 drawn at 1.5×).
 */
import { Resvg } from '@resvg/resvg-js'
import { WEBSITE } from './website-dir'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

// sharp is a dependency of the website, not the app; SHARP_DIR points at another install of it.
const sharpDir = process.env.SHARP_DIR ?? `${WEBSITE}/node_modules/sharp`
const { default: sharp } = (await import(`${sharpDir}/dist/index.mjs`)) as { default: (input: string | Buffer) => any }

const ROOT = process.cwd()
const src = process.argv[2] ?? `${ROOT}/tmp/tweets-src`
const outDir = process.argv[3] ?? `${ROOT}/output/tweets`

const WIDTH = 1600
const HEIGHT = 900
const SCALE = 1.5

/** The site's own colours, as in scripts/og-image.ts. */
const INK = '#F5F3EF'
const MUTED = '#9B99A8'
const BACKGROUND = '#09090C'
const VIOLET = '#8B5CF6'
const VIOLET_SOFT = '#B9A4FB'
const FONT = 'Geist'

// Geist is the website's face; the app's installs are TrueType, which resvg reads (it can't read woff2).
const fontFiles = ['Regular', 'Medium', 'SemiBold', 'Bold']
  .map((w) => `${homedir()}/Library/Fonts/Geist-${w}.ttf`)
  .filter((f) => existsSync(f))
if (fontFiles.length === 0) console.warn('Geist is not installed in ~/Library/Fonts; falling back to Helvetica Neue')

type Crop = { left: number; top: number; width: number; height: number }
type Shot = {
  shot: string
  name: string
  layout: 'wide' | 'split'
  /** Lines of the headline; the last one is drawn in the soft violet. */
  title: string[]
  sub: string[]
  crop?: Crop
  /** The capture brings its own shadow and edge (the menu bar popover); draw it as it is. */
  bare?: boolean
}

// Crops are in the screenshots' Retina pixels (2400×1502). The reader pane starts at x 1530.
const reader = (top: number, height: number): Crop => ({ left: 1530, top, width: 870, height })
const SHOTS: Shot[] = [
  {
    shot: 'hero',
    name: '01-inbox',
    layout: 'wide',
    title: ['Mail, calendar and notes.', 'One Mac app.'],
    sub: [],
  },
  {
    shot: 'quick-add',
    name: '02-add-to-calendar',
    layout: 'split',
    title: ['“Monday at 2pm?”', 'It spots the date.'],
    sub: ['Add it to your calendar in one click,', 'prefilled from the email.'],
    crop: reader(100, 1000),
  },
  {
    shot: 'invite',
    name: '03-invitation',
    layout: 'split',
    title: ['Invitations,', 'answered in the mail.'],
    sub: ['Accept, Maybe or Decline, and see', 'who’s coming, without leaving', 'your inbox.'],
    crop: reader(100, 940),
  },
  {
    shot: 'event',
    name: '04-calendar-event',
    layout: 'wide',
    title: ['Every meeting keeps', 'the email that started it.'],
    sub: [],
  },
  {
    shot: 'notes',
    name: '05-notes',
    layout: 'wide',
    title: ['Notes that link back', 'to the conversation.'],
    sub: [],
  },
  {
    shot: 'menubar-panel',
    name: '06-menu-bar',
    layout: 'split',
    title: ['Your day,', 'in the menu bar.'],
    sub: ['The next meeting, new mail and', 'invitations at a glance, even with', 'the window closed.'],
    bare: true,
  },
]

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Artwork lifted straight from the brand kit so it can never drift from the app's, `width` wide. */
function brand(file: string, x: number, y: number, width: number): string {
  const source = readFileSync(`${ROOT}/brand/${file}`, 'utf8')
  const inner = source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))
  const [, , drawnWidth] = source.match(/viewBox="([^"]+)"/)![1]!.split(' ').map(Number)
  return `<g transform="translate(${x} ${y}) scale(${width / drawnWidth!})">${inner}</g>`
}

/** The screenshot, resized to exactly the pixels it will cover, as a data URL. */
async function picture(file: string, crop: Crop | undefined, width: number) {
  const s = sharp(file)
  const png: Buffer = await (crop ? s.extract(crop) : s).resize({ width: Math.round(width * SCALE) }).png().toBuffer()
  const { width: pw, height: ph } = await sharp(png).metadata()
  return { href: `data:image/png;base64,${png.toString('base64')}`, height: (ph / pw) * width }
}

/** A window: soft shadow, the picture clipped to rounded corners, a hairline edge. */
function frame(id: string, href: string, x: number, y: number, w: number, h: number, r = 18) {
  return `
    <rect x="${x}" y="${y + 24}" width="${w}" height="${h}" rx="${r}" fill="#000" opacity=".7" filter="url(#shadow)"/>
    <clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>
    <image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" clip-path="url(#${id})" preserveAspectRatio="none"/>
    <rect x="${x + 0.75}" y="${y + 0.75}" width="${w - 1.5}" height="${h - 1.5}" rx="${r}" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="1.5"/>`
}

const text = (x: number, y: number, size: number, fill: string, value: string, weight = 400, anchor = 'start') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="${FONT}, Helvetica Neue" font-size="${size}" font-weight="${weight}" letter-spacing="${-size * 0.03}" text-anchor="${anchor}">${escape(value)}</text>`

const headline = (x: number, y: number, size: number, lines: string[], anchor = 'start') =>
  lines.map((line, i) => text(x, y + i * size * 1.12, size, i === lines.length - 1 && lines.length > 1 ? VIOLET_SOFT : INK, line, 600, anchor)).join('')

function background(glowX: number, glowY: number) {
  return `
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#110E1C"/><stop offset="1" stop-color="${BACKGROUND}"/></linearGradient>
      <radialGradient id="glow" cx=".5" cy=".5" r=".5">
        <stop offset="0" stop-color="${VIOLET}" stop-opacity=".5"/>
        <stop offset=".55" stop-color="${VIOLET}" stop-opacity=".12"/>
        <stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/>
      </radialGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="28"/></filter>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
    <ellipse cx="${glowX}" cy="${glowY}" rx="760" ry="520" fill="url(#glow)"/>`
}

async function render(s: Shot, file: string, withText: boolean) {
  let body: string
  if (s.layout === 'wide') {
    // The window runs off the bottom edge; with no headline it rises and fills the frame.
    const w = withText ? 1360 : 1440
    const top = withText ? 94 + s.title.length * 60 + 40 : 80
    const pic = await picture(file, s.crop, w)
    body = `${background(WIDTH / 2, top + 120)}
      ${withText ? headline(WIDTH / 2, 118, 54, s.title, 'middle') : ''}
      ${frame('win', pic.href, (WIDTH - w) / 2, top, w, pic.height)}`
  } else {
    // Headline left, the crop right, centred in the height with room for its shadow.
    const maxH = s.bare ? 820 : 740
    const maxW = withText ? 780 : 1200
    const probe = await picture(file, s.crop, 100)
    const aspect = probe.height / 100
    const w = Math.min(maxW, maxH / aspect)
    const pic = await picture(file, s.crop, w)
    const x = withText ? WIDTH - 110 - w : (WIDTH - w) / 2
    const y = (HEIGHT - pic.height) / 2
    const lines = s.title.length * 58 * 1.12 + (s.sub.length ? 36 + s.sub.length * 36 : 0)
    const ty = (HEIGHT - lines) / 2 + 48
    const sub = s.sub.map((line, i) => text(110, ty + s.title.length * 58 * 1.12 + 22 + i * 36, 26, MUTED, line)).join('')
    body = `${background(x + w / 2, HEIGHT / 2)}
      ${withText ? `${brand('logo/jefi-logo-white.svg', 110, 90, 96)}${headline(110, ty, 58, s.title)}${sub}` : ''}
      ${s.bare ? `<image href="${pic.href}" x="${x}" y="${y}" width="${w}" height="${pic.height}"/>` : frame('win', pic.href, x, y, w, pic.height, 22)}`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${body}</svg>`
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH * SCALE },
    background: BACKGROUND,
    font: { fontFiles, loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' },
  })
    .render()
    .asPng()
}

mkdirSync(outDir, { recursive: true })
for (const s of SHOTS) {
  const file = `${src}-${s.shot}-dark.png`
  if (!existsSync(file)) {
    console.log(`skipped ${s.name} (no ${file})`)
    continue
  }
  for (const withText of [true, false]) {
    const name = withText ? s.name : `${s.name}-clean`
    const png = await render(s, file, withText)
    // Recompress: resvg writes large, unoptimised PNGs.
    const out = await sharp(png).png({ compressionLevel: 9, effort: 10 }).toFile(`${outDir}/${name}.png`)
    console.log(`${name}: ${out.width}×${out.height}, ${Math.round(out.size / 1024)} KB`)
  }
}
