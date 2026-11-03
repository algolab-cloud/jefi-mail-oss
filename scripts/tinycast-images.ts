/**
 * Web images for the "Install the Jefi extension in Tinycast" post, from window captures of
 * Tinycast (screencapture -l, shadow included) with the extension pointed at scripts/raycast-demo.ts.
 * Each window is cut out of its captured shadow (which picks up whatever was behind it) and set on a
 * dark backdrop with a drawn shadow; sheets cut out of a window get rounded corners.
 *
 *   bun scripts/tinycast-images.ts [captures dir]   → ../website/public/img/tinycast-*.webp/png
 */
import { mkdirSync } from 'node:fs'
import { WEBSITE } from './website-dir'

// sharp is a dependency of the website, not the app; SHARP_DIR points at another install of it.
const sharpDir = process.env.SHARP_DIR ?? `${WEBSITE}/node_modules/sharp`
const { default: sharp } = (await import(`${sharpDir}/dist/index.mjs`)) as { default: (input: string | Buffer | object) => any }

const src = process.argv[2] ?? `${process.cwd()}/tmp/tinycast-shots`
const dir = `${WEBSITE}/public/img`

type Crop = { left: number; top: number; width: number; height: number }
const IMAGES: Array<{ shot: string; name: string; width: number; sheet?: Crop; radius?: number }> = [
  // Just the sheets: the settings behind them show a custom search path of mine.
  { shot: 's-add', name: 'tinycast-add-registry', width: 1400, sheet: { left: 533, top: 513, width: 957, height: 630 }, radius: 40 },
  { shot: 's-registries', name: 'tinycast-registries', width: 1400, sheet: { left: 470, top: 245, width: 952, height: 893 }, radius: 40 },
  { shot: 'keep-2-search', radius: 56, name: 'tinycast-search-extensions', width: 1800 },
  { shot: 'keep-4-settings', radius: 56, name: 'tinycast-jefi-settings', width: 1800 },
  { shot: 'keep-5-commands', radius: 72, name: 'tinycast-jefi-commands', width: 1600 },
  { shot: 'keep-6-search-mail', radius: 72, name: 'tinycast-search-mail', width: 1600 },
  { shot: 'keep-7-today', radius: 72, name: 'tinycast-today', width: 1600 },
]

// The captured shadow is at most ~90 alpha where it meets the window; the window itself is opaque.
const SHADOW_ALPHA = 90

/** The window alone: cropped to where it's opaque, with the captured shadow (and whatever showed
 *  through it) made transparent, so its own rounded corners are kept. */
async function window(file: string): Promise<Buffer> {
  const { data, info } = await sharp(file).extractChannel(3).raw().toBuffer({ resolveWithObject: true })
  let [x0, y0, x1, y1] = [info.width, info.height, 0, 0]
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[y * info.width + x] >= 250) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]
  const crop = { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
  const alpha = Buffer.alloc(crop.width * crop.height)
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++) {
      const a = data[(y + crop.top) * info.width + x + crop.left]!
      alpha[y * crop.width + x] = Math.max(0, Math.round(((a - SHADOW_ALPHA) * 255) / (255 - SHADOW_ALPHA)))
    }
  // Two steps: in one pipeline sharp would join the new alpha before removing the old one.
  const rgb = await sharp(file).extract(crop).removeAlpha().png().toBuffer()
  return sharp(rgb).joinChannel(alpha, { raw: { width: crop.width, height: crop.height, channels: 1 } }).png().toBuffer()
}

/** A sheet cut out of a window capture, with rounded corners. */
async function sheet(file: string, crop: Crop): Promise<Buffer> {
  const mask = Buffer.from(`<svg width="${crop.width}" height="${crop.height}"><rect width="100%" height="100%" rx="40" ry="40"/></svg>`)
  const cut = await sharp(file).extract(crop).png().toBuffer()
  return sharp(cut).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
}

/** The cut-out on a backdrop with room around it, and one soft shadow beneath it, rounded like it. */
async function frame(cutout: Buffer, radius: number): Promise<Buffer> {
  const { width: w, height: h } = await sharp(cutout).metadata()
  const pad = Math.round(Math.max(w, h) * 0.08)
  const [W, H] = [w + pad * 2, h + pad * 2]
  const shadow = Buffer.from(
    `<svg width="${W}" height="${H}"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${Math.round(pad * 0.3)}"/></filter></defs>` +
      `<rect x="${pad}" y="${pad + Math.round(pad * 0.18)}" width="${w}" height="${h}" rx="${radius}" fill="#000" fill-opacity="0.5" filter="url(#s)"/></svg>`,
  )
  return sharp(backdrop(W, H))
    .composite([{ input: shadow }, { input: cutout, left: pad, top: pad }])
    .png()
    .toBuffer()
}

function backdrop(width: number, height: number) {
  return Buffer.from(
    `<svg width="${width}" height="${height}"><defs>` +
      `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c1a26"/><stop offset="1" stop-color="#0c0c10"/></linearGradient>` +
      `<radialGradient id="glow" cx="0.18" cy="0.08" r="0.75"><stop offset="0" stop-color="#8b5cf6" stop-opacity="0.22"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient>` +
      `</defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#glow)"/></svg>`,
  )
}

mkdirSync(dir, { recursive: true })
for (const image of IMAGES) {
  const file = `${src}/${image.shot}.png`
  const framed = await frame(image.sheet ? await sheet(file, image.sheet) : await window(file), image.radius ?? 40)
  const resized = () => sharp(framed).resize({ width: image.width, withoutEnlargement: true })
  const webp = await resized().webp({ quality: 84, effort: 6 }).toFile(`${dir}/${image.name}.webp`)
  const png = await resized().png({ compressionLevel: 9 }).toFile(`${dir}/${image.name}.png`)
  console.log(image.name, `${webp.width}x${webp.height}`, `webp ${Math.round(webp.size / 1024)}K`, `png ${Math.round(png.size / 1024)}K`)
}
