/**
 * Builds Jefi's brand kit from the source artwork in assets/icon.svg (and assets/logo.svg, a lockup,
 * when there is one).
 *
 *   bun run brand
 *
 * Writes brand/ (see brand/README.md):
 *   logo/       the lockup (or the mark, with no lockup source), black and white, as SVG and PNG
 *   mark/       the mark alone, black and white, as SVG and PNG
 *   app-icon/   the macOS icon: SVG, 1024 PNG, one PNG per accent, AppIcon.iconset + AppIcon.icns
 *   web/        favicon.svg / favicon.ico, apple-touch-icon, logo192 / logo512 (also copied to ../website/public/)
 * and src/assets/brand/*.svg: mark, wordmark and avatar for use inside the app.
 */
import { Resvg } from '@resvg/resvg-js'
import { WEBSITE } from './website-dir'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { ACCENTS, mixHex } from '../src/theme'

const ROOT = process.cwd()
const OUT = `${ROOT}/brand`
const APP_OUT = `${ROOT}/src/assets/brand`

export const BRAND = {
  /** Default mark colour: Jefi violet. Per-accent Dock icons swap this for the accent. */
  ink: '#8B5CF6',
  /** The tile is white, shading to a faint cool grey at its base. */
  tile: ['#FFFFFF', '#ECEDF2'],
}

// ---------------------------------------------------------------------------
// Pull the geometry out of the source SVGs (exported from Affinity)
// ---------------------------------------------------------------------------

const svg = (viewBox: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`

/**
 * An Affinity export flattened to plain black paths, cropped tight to its ink. Affinity nests
 * scaled and rotated groups and pads the viewBox to whole units; here every group transform is
 * baked into the path coordinates (the paths use absolute M/L/C/Z only) and the origin moved to
 * the artwork's corner, so the result can be tinted, stroked and sized from its viewBox alone.
 */
function artwork(file: string) {
  type Matrix = [number, number, number, number, number, number]
  const multiply = ([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix =>
    [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f]
  const source = readFileSync(`${ROOT}/assets/${file}`, 'utf8')
  const stack: Matrix[] = [[1, 0, 0, 1, 0, 0]]
  const paths: Array<{ points: number[][]; commands: string[]; fillRule: string }> = []
  for (const [tag] of source.matchAll(/<\/?(?:g|path)\b[^>]*>/g)) {
    if (tag.startsWith('</g')) stack.pop()
    else if (tag.startsWith('<g')) {
      const m = tag.match(/transform="matrix\(([^)]+)\)"/)
      stack.push(m ? multiply(stack.at(-1)!, m[1]!.split(/[\s,]+/).map(Number) as Matrix) : stack.at(-1)!)
    } else {
      const [a, b, c, d, e, f] = stack.at(-1)!
      const commands: string[] = []
      const points: number[][] = []
      for (const [, command, args] of tag.match(/ d="([^"]+)"/)![1]!.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
        const numbers = args!.trim() ? args!.trim().split(/[\s,]+/).map(Number) : []
        const pairs: number[] = []
        for (let i = 0; i < numbers.length; i += 2) {
          const [x, y] = [numbers[i]!, numbers[i + 1]!]
          pairs.push(a * x + c * y + e, b * x + d * y + f)
        }
        commands.push(command!)
        points.push(pairs)
      }
      // The root sets evenodd; Affinity overrides it per path where it differs.
      paths.push({ commands, points, fillRule: /fill-rule:\s*nonzero/.test(tag) ? 'nonzero' : 'evenodd' })
    }
  }
  const draw = (dx: number, dy: number) =>
    paths
      .map(({ commands, points, fillRule }) => {
        const d = commands
          .map((command, i) => command + points[i]!.map((n, j) => +(n + (j % 2 ? dy : dx)).toFixed(3)).join(' '))
          .join('')
        return `<path fill="#000" fill-rule="${fillRule}" d="${d}"/>`
      })
      .join('')
  const box = new Resvg(svg('0 0 1 1', draw(0, 0))).getBBox()!
  return {
    width: Math.ceil(box.width * 1000) / 1000,
    height: Math.ceil(box.height * 1000) / 1000,
    /** The artwork's paths, drawn in a `width` × `height` box from the origin. */
    body: draw(-box.x, -box.y),
  }
}

// icon.svg is the mark alone; logo.svg, when present, is a lockup of the mark and lettering. Without
// one the mark is the logo too, so the lockup's consumers (onboarding) show it.
const MARK = artwork('icon.svg')
const LOGO = existsSync(`${ROOT}/assets/logo.svg`) ? artwork('logo.svg') : MARK

// ---------------------------------------------------------------------------
// In-app vectors (single colour; the app tints them)
// ---------------------------------------------------------------------------

const mark = svg(`0 0 ${MARK.width} ${MARK.height}`, MARK.body)
const wordmark = svg(`0 0 ${LOGO.width} ${LOGO.height}`, LOGO.body)

// ---------------------------------------------------------------------------
// macOS app icon
// ---------------------------------------------------------------------------

// Apple's macOS icon grid: an 824pt rounded square centred on a 1024 artboard.
const TILE = { x: 100, y: 100, size: 824, radius: 185.4 }
// The mark fills most of the tile so it still reads at Dock size; sized by width, centred.
const MARK_WIDTH = 600
const markScale = MARK_WIDTH / MARK.width
const markX = 512 - MARK_WIDTH / 2
const markY = 512 - (MARK.height * markScale) / 2

function appIcon({ shadow, ink = BRAND.ink }: { shadow: boolean; ink?: string }) {
  return svg(
    '0 0 1024 1024',
    `
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BRAND.tile[0]}"/>
      <stop offset="1" stop-color="${BRAND.tile[1]}"/>
    </linearGradient>
    <linearGradient id="mark" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${MARK.height}">
      <stop offset="0" stop-color="${mixHex(ink, '#FFFFFF', 0.2)}"/>
      <stop offset="1" stop-color="${mixHex(ink, '#000000', 0.12)}"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
  </defs>
  ${
    // The shadow is its own blurred shape: filtering the gradient tile itself made resvg band it.
    shadow ? `<rect x="${TILE.x}" y="${TILE.y + 10}" width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}" fill="#000" opacity="0.22" filter="url(#drop)"/>` : ''
  }
  <rect x="${TILE.x}" y="${TILE.y}" width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}" fill="url(#tile)"/>
  <rect x="${TILE.x + 1}" y="${TILE.y + 1}" width="${TILE.size - 2}" height="${TILE.size - 2}" rx="${TILE.radius - 1}" fill="none" stroke="#000" stroke-opacity="0.06" stroke-width="2"/>
  <g transform="translate(${markX} ${markY}) scale(${markScale})">${MARK.body.replaceAll('fill="#000"', 'fill="url(#mark)"')}</g>
`,
  )
}

/** The tile alone, cropped to its bounds: used where Jefi appears as an avatar inside the app. */
const avatar = () => appIcon({ shadow: false }).replace('viewBox="0 0 1024 1024"', `viewBox="${TILE.x} ${TILE.y} ${TILE.size} ${TILE.size}"`)

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------

const render = (source: string, size: number) =>
  new Resvg(source, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng()

// Clear the generated folders only: brand/README.md is written by hand.
for (const dir of ['logo', 'mark', 'app-icon', 'web']) rmSync(`${OUT}/${dir}`, { recursive: true, force: true })
for (const dir of ['logo', 'mark', 'app-icon/AppIcon.iconset', 'web']) mkdirSync(`${OUT}/${dir}`, { recursive: true })
mkdirSync(APP_OUT, { recursive: true })

const recolor = (source: string, color: string) => source.replaceAll('fill="#000"', `fill="${color}"`)
const renderHeight = (source: string, height: number, aspect: number) =>
  new Resvg(source, { fitTo: { mode: 'width', value: Math.round(height * aspect) }, background: 'rgba(0,0,0,0)' }).render().asPng()

// --- logo: the lockup ---------------------------------------------------------------------------
for (const [suffix, color] of [['', '#000000'], ['-white', '#FFFFFF']] as const) {
  const logo = recolor(wordmark, color)
  writeFileSync(`${OUT}/logo/jefi-logo${suffix}.svg`, logo)
  writeFileSync(`${OUT}/logo/jefi-logo${suffix}.png`, renderHeight(logo, 256, LOGO.width / LOGO.height))
}

// --- mark: the mark alone ----------------------------------------------------------------------
for (const [suffix, color] of [['', '#000000'], ['-white', '#FFFFFF']] as const) {
  const m = recolor(mark, color)
  writeFileSync(`${OUT}/mark/jefi-mark${suffix}.svg`, m)
  // Sized by width: the mark is a little wider than it is tall, so this is its longest side.
  for (const size of [64, 256, 1024]) writeFileSync(`${OUT}/mark/jefi-mark${suffix}-${size}.png`, render(m, size))
}

// --- app-icon: macOS ----------------------------------------------------------------------------
const icon = appIcon({ shadow: true })
writeFileSync(`${OUT}/app-icon/jefi-app-icon.svg`, icon)
writeFileSync(`${OUT}/app-icon/icon-1024.png`, render(icon, 1024))
// One Dock icon per accent: the running app shows the one matching the chosen accent.
for (const [name, { accent }] of Object.entries(ACCENTS)) {
  writeFileSync(`${OUT}/app-icon/icon-${name}-1024.png`, render(appIcon({ shadow: true, ink: accent }), 1024))
}
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(`${OUT}/app-icon/AppIcon.iconset/icon_${size}x${size}.png`, render(icon, size))
  writeFileSync(`${OUT}/app-icon/AppIcon.iconset/icon_${size}x${size}@2x.png`, render(icon, size * 2))
}
execFileSync('iconutil', ['-c', 'icns', `${OUT}/app-icon/AppIcon.iconset`, '-o', `${OUT}/app-icon/AppIcon.icns`])

// --- web: favicons ------------------------------------------------------------------------------
// The tile without the macOS shadow and padding reads better at favicon sizes.
const tile = avatar()
writeFileSync(`${OUT}/web/favicon.svg`, tile)
const tilePng = (size: number) => new Resvg(tile, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng()
writeFileSync(`${OUT}/web/apple-touch-icon.png`, tilePng(180))
writeFileSync(`${OUT}/web/logo192.png`, tilePng(192))
writeFileSync(`${OUT}/web/logo512.png`, tilePng(512))
writeFileSync(`${OUT}/web/favicon.ico`, ico([16, 32, 48].map((size) => ({ size, png: tilePng(size) }))))
// The website serves the same files.
for (const file of readdirSync(`${OUT}/web`)) cpSync(`${OUT}/web/${file}`, `${WEBSITE}/public/${file}`)
// And the full app icon the landing page closes on.
cpSync(`${OUT}/app-icon/icon-1024.png`, `${WEBSITE}/public/img/jefi-icon.png`)

// --- in-app vectors -----------------------------------------------------------------------------
// `bun --hot` reloads on every change under src/. Writing in place let a running app import a
// half-written SVG, which GPUI shows as "load failed"; write a sibling and rename it over instead.
const writeAtomic = (path: string, data: string) => {
  writeFileSync(`${path}.tmp`, data)
  renameSync(`${path}.tmp`, path)
}
writeAtomic(`${APP_OUT}/mark.svg`, mark)
writeAtomic(`${APP_OUT}/wordmark.svg`, wordmark)
writeAtomic(`${APP_OUT}/avatar.svg`, tile)
rmSync(`${APP_OUT}/star.svg`, { force: true }) // part of the old crescent mark

// GPUI shows a "load failed" placeholder for malformed SVG, so check every vector parses.
for (const file of [
  `${APP_OUT}/mark.svg`, `${APP_OUT}/wordmark.svg`, `${APP_OUT}/avatar.svg`,
  `${OUT}/logo/jefi-logo.svg`, `${OUT}/mark/jefi-mark.svg`, `${OUT}/app-icon/jefi-app-icon.svg`, `${OUT}/web/favicon.svg`,
]) execFileSync('xmllint', ['--noout', file])

console.log('brand kit written to brand/ and src/assets/brand/')

/** A .ico holding PNG images (supported everywhere since Windows Vista, and by every browser). */
function ico(images: Array<{ size: number; png: Buffer }>) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4) // colour planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((i) => i.png)])
}
