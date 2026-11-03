/**
 * Web images for jefi.app from the marketing screenshots (scripts/shot-marketing.ts): WebP plus a
 * PNG fallback. The site is dark, so the dark set goes to ../website/public/img; the light set goes to
 * tmp/marketing-web for press and review. The menu bar panel, shot in place over a wallpaper window,
 * gets a drawn menu bar strip above it with the real item in it, so it reads as a product shot.
 *
 *   bun scripts/marketing-images.ts [prefix]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { WEBSITE } from './website-dir'

// sharp is a dependency of the website, not the app; SHARP_DIR points at another install of it.
const sharpDir = process.env.SHARP_DIR ?? `${WEBSITE}/node_modules/sharp`
const { default: sharp } = (await import(`${sharpDir}/dist/index.mjs`)) as { default: (input: string | Buffer) => any }

const src = process.argv[2] ?? `${process.cwd()}/tmp/marketing`

type Crop = { left: number; top: number; width: number; height: number }
// Reader shots keep the message list and the reader; the sidebar adds nothing to them.
const readerCrop: Crop = { left: 650, top: 0, width: 1750, height: 1502 }
const IMAGES: Array<{ shot: string; name: string; width: number; crop?: Crop }> = [
  { shot: 'hero', name: 'jefi-inbox', width: 2400 },
  { shot: 'event', name: 'jefi-calendar-event', width: 1800 },
  { shot: 'quick-add', name: 'jefi-add-to-calendar', width: 1600, crop: readerCrop },
  // Cut above the attachment row: the reader lists the invitation's text/calendar part as a file.
  { shot: 'invite', name: 'jefi-invite', width: 1600, crop: { ...readerCrop, height: 1060 } },
  { shot: 'notes', name: 'jefi-notes', width: 1800 },
  // From scripts/shot-tasks.ts with --accent=violet --window=1200x750, same prefix.
  { shot: 'list', name: 'jefi-tasks', width: 1800 },
  { shot: 'sheet', name: 'jefi-tasks-sheet', width: 1800 },
  { shot: 'board', name: 'jefi-tasks-board', width: 1800 },
  { shot: 'calendar-card', name: 'jefi-tasks-calendar', width: 1800 },
  { shot: 'make-task', name: 'jefi-make-task', width: 1800 },
]

// ---------------------------------------------------------------------------
// The menu bar shot, in Retina pixels. shot-marketing.ts captured the popover in place over a
// wallpaper window that covered the real menu bar too (so the glass really picks it up), and wrote
// down where everything was; the menu bar is drawn over its top, with the item's own button where it stood.
// ---------------------------------------------------------------------------

type Shot = { region: string; scale: number; left: number; bar: number; width: number; height: number; item: { x: number; y: number; width: number; height: number } }

async function menuBarScene(theme: 'dark' | 'light') {
  const shot = JSON.parse(readFileSync(`${src}-menubar-${theme}.json`, 'utf8')) as Shot
  const px = (points: number) => Math.round(points * shot.scale)
  const width = px(shot.width)
  const bar = px(shot.bar)
  const dark = theme === 'dark'
  const ink = dark ? '#ffffff' : '#111111'
  // The item snapshot is a template image drawn dark; the dark bar wants it light.
  const itemSrc = sharp(`${src}-menubar-item-${theme}.png`)
  const item: Buffer = await (dark ? itemSrc.negate({ alpha: false }) : itemSrc).png().toBuffer()
  const { width: iw, height: ih } = await sharp(item).metadata()
  const itemLeft = px(shot.item.x - shot.left)
  const itemTop = px(shot.item.y) + Math.round((px(shot.item.height) - ih) / 2)

  const label = (x: number, text: string, anchor = 'start', weight = 500) =>
    `<text x="${x}" y="${bar / 2 + 9}" font-family="SF Pro Text, Helvetica Neue, Helvetica" font-size="26" font-weight="${weight}" fill="${ink}" text-anchor="${anchor}">${text}</text>`
  const now = new Date()
  const clock = `${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')}  ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  // Plain shapes for the system items right of Jefi: wi-fi, battery, a switch (left out if the item is in their way).
  const x = width - 500
  const mid = bar / 2
  const system = itemLeft + iw > x - 30 ? '' : `<g fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round" opacity=".9">
      <path d="M${x} ${mid - 3} a19 19 0 0 1 28 0 M${x + 6} ${mid + 3} a10 10 0 0 1 16 0"/>
      <circle cx="${x + 14}" cy="${mid + 10}" r="2.6" fill="${ink}" stroke="none"/>
      <rect x="${x + 54}" y="${mid - 9}" width="40" height="18" rx="5"/><rect x="${x + 58}" y="${mid - 5}" width="26" height="10" rx="2" fill="${ink}" stroke="none"/>
      <path d="M${x + 98} ${mid - 4} v8"/>
      <rect x="${x + 124}" y="${mid - 9}" width="34" height="18" rx="9"/><circle cx="${x + 149}" cy="${mid}" r="5" fill="${ink}" stroke="none"/>
    </g>`
  // The macOS 26 menu bar is clear: the wallpaper itself, with a faint wash for legibility.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bar}">
    <rect width="100%" height="100%" fill="${dark ? '#000' : '#fff'}" fill-opacity="${dark ? 0.12 : 0.22}"/>
    ${label(40, 'Jefi', 'start', 700)}${label(118, 'File')}${label(186, 'Edit')}${label(256, 'View')}${label(334, 'Window')}${label(450, 'Help')}
    <rect x="${itemLeft - 10}" y="${Math.round((bar - 44) / 2)}" width="${iw + 20}" height="44" rx="22" fill="${ink}" fill-opacity="${dark ? 0.2 : 0.12}"/>
    ${system}
    ${label(width - 36, clock, 'end')}
  </svg>`
  return sharp(shot.region)
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, { input: item, left: itemLeft, top: itemTop }])
    .png()
    .toBuffer() as Promise<Buffer>
}

// The window's close / minimise / zoom buttons are native, so GPUIX screenshots don't have them. Drawn
// where macOS puts them, in Retina pixels measured from a real Jefi window (14 pt buttons, 23 pt apart).
const TRAFFIC_LIGHTS = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="168" height="80">
  ${[['#FF5F57', 37.5], ['#FEBC2E', 83.5], ['#28C840', 129.5]]
    .map(([fill, cx]) => `<circle cx="${cx}" cy="50" r="13.5" fill="${fill}" stroke="#000" stroke-opacity=".14" stroke-width="1"/>`)
    .join('')}
</svg>`)

for (const [theme, dir] of [['dark', `${WEBSITE}/public/img`], ['light', `${process.cwd()}/tmp/marketing-web`]] as const) {
  mkdirSync(dir, { recursive: true })
  const save = async (name: string, image: () => any) => {
    const file = theme === 'dark' ? name : `${name}-light`
    const webp = await image().webp({ quality: 82, effort: 6 }).toFile(`${dir}/${file}.webp`)
    const png = await image().png({ palette: true, quality: 90, compressionLevel: 9, effort: 10 }).toFile(`${dir}/${file}.png`)
    console.log(`${file}: ${webp.width}×${webp.height}, webp ${Math.round(webp.size / 1024)} KB, png ${Math.round(png.size / 1024)} KB`)
  }
  for (const image of IMAGES) {
    // A --menubar-only run of shot-marketing leaves the window shots out; keep what is there.
    if (!existsSync(`${src}-${image.shot}-${theme}.png`)) {
      console.log(`skipped ${image.name} (no ${image.shot} shot)`)
      continue
    }
    const file = `${src}-${image.shot}-${theme}.png`
    // A crop that starts right of the window's corner has no buttons to show, and a glass shot
    // (captured from the screen) already has the real ones: the close button's red is there.
    const { data: close } = await sharp(file).extract({ left: 36, top: 49, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const hasButtons = close[0]! > 200 && close[1]! < 130
    const framed: Buffer | string =
      (image.crop && image.crop.left > 0) || hasButtons ? file : await sharp(file).composite([{ input: TRAFFIC_LIGHTS, left: 0, top: 0 }]).png().toBuffer()
    await save(image.name, () => {
      const s = sharp(framed)
      return (image.crop ? s.extract(image.crop) : s).resize({ width: image.width })
    })
  }
  // A tasks-only run has no menu bar captures; keep the published picture.
  if (!existsSync(`${src}-menubar-panel-${theme}.png`)) {
    console.log('skipped jefi-menu-bar (no menu bar shot)')
    continue
  }
  const scene = await menuBarScene(theme)
  await save('jefi-menu-bar', () => sharp(scene).resize({ width: 1200 }))
}
