/**
 * Raycast Store screenshots for the Jefi extension: integrations/raycast/metadata/jefi-N.png, 2000×1250.
 *
 * Needs Raycast running with the extension loaded by `ray develop` and its "Jefi Executable"
 * preference pointing at the demo from scripts/raycast-demo.ts (never real mail). Each command is
 * opened by deeplink, its window moved onto a Retina screen, captured with its shadow by
 * `screencapture -l` and centred on a soft gradient, the way Raycast's own Window Capture frames it.
 * Drives Raycast with System Events, so the terminal needs Accessibility access.
 *
 *   bun scripts/raycast-screenshots.ts [--at=489,250] [--menu-at=454,16] [--only=1,3] [--qa-downs=7]
 *
 * --at is where the window goes (points, on a Retina screen); --menu-at is where the Unread Mail item
 * sits in that screen's menu bar (it is clicked to open the menu).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { WEBSITE } from './website-dir'

const root = process.cwd()
const tmp = `${root}/tmp/raycast-shots`
const outDir = `${root}/integrations/raycast/metadata`
mkdirSync(tmp, { recursive: true })
mkdirSync(outDir, { recursive: true })
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const [atX, atY] = (arg('at') ?? '489,250').split(',').map(Number)
const [menuX, menuY] = (arg('menu-at') ?? '454,16').split(',').map(Number)
const qaDowns = Number(arg('qa-downs') ?? 7)
const only = arg('only')?.split(',').map(Number)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sharpDir = process.env.SHARP_DIR ?? `${WEBSITE}/node_modules/sharp`
const { default: sharp } = (await import(`${sharpDir}/dist/index.mjs`)) as { default: (input: string | Buffer | object) => any }

// A tiny window lister and clicker; CGWindowList is the only way to get window ids for screencapture.
const swift = `import CoreGraphics
import Foundation
let a = CommandLine.arguments
if a[1] == "click" {
  let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
  for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
    usleep(80_000)
  }
} else {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list where (w[kCGWindowOwnerName as String] as? String) == "Raycast" {
    let b = w[kCGWindowBounds as String] as! [String: Any]
    print(w[kCGWindowNumber as String]!, w[kCGWindowLayer as String]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!)
  }
}
`
writeFileSync(`${tmp}/tool.swift`, swift)
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}
run(['swiftc', '-O', `${tmp}/tool.swift`, '-o', `${tmp}/tool`])
const windows = () =>
  run([`${tmp}/tool`, 'list'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' ').map(Number))
    .map(([id, layer, x, y, w, h]) => ({ id: id!, layer: layer!, x: x!, y: y!, w: w!, h: h! }))
const osa = (...lines: string[]) => run(['osascript', ...lines.flatMap((l) => ['-e', l])])
const keys = (...lines: string[]) => osa('tell application "System Events"', ...lines, 'end tell')
const shown = () => windows().find((w) => w.layer === 8 && w.w > 600)
/** Closes Raycast's window and waits until it's really gone, so the next deeplink starts fresh. */
async function escape() {
  for (let i = 0; i < 30 && shown(); i++) {
    keys('key code 53')
    await wait(250)
  }
  await wait(400)
}

/** Opens a deeplink (always in Raycast: Tinycast claims raycast:// too), then puts the window on the Retina screen. */
async function open(url: string) {
  // Right after Raycast hides, a deeplink is sometimes swallowed; ask again until the window shows.
  for (let attempt = 0; attempt < 4; attempt++) {
    run(['open', '-a', 'Raycast', url])
    for (let i = 0; i < 25; i++) {
      await wait(100)
      const w = shown()
      if (!w) continue
      await wait(300)
      if (!shown()) break
      osa(`tell application "System Events" to tell process "Raycast" to set position of window 1 to {${atX}, ${atY}}`)
      return w
    }
  }
  throw new Error(`the Raycast window never showed for ${url}`)
}

// Jefi's violet and indigo, soft and dark, so the dark Raycast window reads clearly on it.
function background(w: number, h: number) {
  const blobs: Array<[number, number, number, string, number]> = [
    [0.78, 0.12, 0.55, '#6d4cff', 0.75],
    [0.2, 0.85, 0.5, '#3a52e0', 0.6],
    [0.95, 0.9, 0.4, '#c24bd1', 0.45],
    [0.08, 0.1, 0.35, '#8a3ffc', 0.4],
  ]
  const defs = blobs.map(([, , , c, o], i) => `<radialGradient id="b${i}"><stop offset="0" stop-color="${c}" stop-opacity="${o}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('')
  const shapes = blobs.map(([x, y, r], i) => `<ellipse cx="${x * w}" cy="${y * h}" rx="${r * w}" ry="${r * w * 0.8}" fill="url(#b${i})"/>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#15103a"/><stop offset=".55" stop-color="#1d1650"/><stop offset="1" stop-color="#101838"/></linearGradient>${defs}</defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`)
}

const W = 2000
const H = 1250

/** The captured window (with its shadow) centred on the background. */
async function frame(capture: string, name: string) {
  const meta = await sharp(capture).metadata()
  if (meta.width! > W || meta.height! > H) throw new Error(`${capture} is ${meta.width}×${meta.height}: is the window on a Retina screen?`)
  await sharp(await sharp(background(W, H)).png().toBuffer())
    .composite([{ input: capture, left: Math.round((W - meta.width!) / 2), top: Math.round((H - meta.height!) / 2) }])
    .png()
    .toFile(`${outDir}/${name}`)
  console.log('saved', `${outDir}/${name}`)
}

async function shotWindow(n: number, prepare: () => Promise<{ id: number }>, settle = 2500) {
  if (only && !only.includes(n)) return
  await escape()
  const w = await prepare()
  await wait(settle)
  const capture = `${tmp}/raw-${n}.png`
  run(['screencapture', '-x', '-l', String(w.id), capture])
  await frame(capture, `jefi-${n}.png`)
}

await shotWindow(1, () => open('raycast://extensions/jefi/jefi/search-mail?fallbackText=offsite'), 6000)
await shotWindow(2, () => open('raycast://extensions/jefi/jefi/inbox'), 5000)
await shotWindow(3, () => open('raycast://extensions/jefi/jefi/today'), 4000)
await shotWindow(4, async () => {
  const w = await open('raycast://extensions/jefi/jefi/compose')
  await wait(1500)
  // Fill the form by keyboard; nothing is submitted.
  keys(
    'keystroke "lea@atlas.dev"', 'key code 48', 'delay 0.2', 'key code 48', 'delay 0.2',
    'keystroke "Board dry run on Monday"', 'key code 48', 'delay 0.2',
    'keystroke "Hi Lea, Monday at 2pm works. I will bring the pricing numbers and the churn chart."',
  )
  return w
}, 1200)
await shotWindow(5, async () => {
  // Root search filtered to the extension, Quick Add selected with its sentence typed in. raycast://
  // can bring back the last command, so start from one of ours and pop to the root with Escape.
  const w = await open('raycast://extensions/jefi/jefi/compose')
  await wait(1200)
  keys('key code 53', 'delay 0.8', 'keystroke "jefi"', 'delay 2')
  // Root results are ranked by use, so where Quick Add sits varies: --qa-downs says how far down.
  keys(`repeat ${qaDowns} times`, 'key code 125', 'delay 0.15', 'end repeat', 'delay 0.8', 'key code 48', 'delay 0.8', 'keystroke "Lunch Friday 1pm"')
  return w
}, 1000)

// The menu bar command: its menu, under a strip of menu bar holding only its item.
if (!only || only.includes(6)) {
  await escape()
  run([`${tmp}/tool`, 'click', String(menuX), String(menuY)])
  let menu
  for (let i = 0; i < 40 && !menu; i++) {
    menu = windows().find((w) => w.layer === 101)
    if (!menu) await wait(100)
  }
  if (!menu) throw new Error('the Unread Mail menu never opened; check --menu-at')
  await wait(800)
  const menuPng = `${tmp}/raw-menu.png`
  const itemPng = `${tmp}/raw-item.png`
  run(['screencapture', '-x', '-l', String(menu.id), menuPng])
  // The item: from the menu's left edge (menus open under their item) to just past its count.
  const itemW = 54
  run(['screencapture', '-x', '-R', `${menu.x + 4},0,${itemW},${menu.y - 9}`, itemPng])
  keys('key code 53')

  // Scaled up so the menu reads at Store size; 2× captures keep it sharp enough at 1.75×.
  const s = 1.75
  const m = await sharp(menuPng).metadata()
  const menuImg = await sharp(menuPng).resize(Math.round(m.width! * s)).png().toBuffer()
  const mm = await sharp(menuImg).metadata()
  const barH = Math.round((menu.y - 9) * 2 * s)
  // The item was shot on this Mac's own menu bar; keep only its dark glyph and redraw it white, so no
  // wallpaper or neighbouring icons come along. Alpha is how much darker than the bar a pixel is.
  const grey = await sharp(itemPng).resize({ height: barH }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const { width: gw, height: gh } = grey.info
  let bg = 0
  for (const v of grey.data) bg = Math.max(bg, v)
  const rgba = Buffer.alloc(gw * gh * 4, 255)
  for (let i = 0; i < gw * gh; i++) rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(((bg - 45 - grey.data[i]!) / (bg * 0.55)) * 255)))
  const item = await sharp(rgba, { raw: { width: gw, height: gh, channels: 4 } }).png().toBuffer()
  const pad = (mm.width! - menu.w * 2 * s) / 2
  const frameLeft = Math.round((W - menu.w * 2 * s) / 2)
  const itemLeft = frameLeft + Math.round(4 * 2 * s)
  const pill = Math.round(6 * s)
  const bar = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${barH}"><rect width="100%" height="100%" fill="#ffffff" fill-opacity="0.12"/><rect x="${itemLeft - pill}" y="${pill}" width="${gw + 2 * pill}" height="${barH - 2 * pill}" rx="${barH / 2 - pill}" fill="#ffffff" fill-opacity="0.2"/></svg>`)
  await sharp(await sharp(background(W, H)).png().toBuffer())
    .composite([
      { input: bar, left: 0, top: 0 },
      { input: item, left: itemLeft, top: 0 },
      // The menu's shadow margin puts its frame just under the bar, as on screen.
      { input: menuImg, left: Math.round(frameLeft - pad), top: barH - Math.round((mm.height! - menu.h * 2 * s) / 2) + Math.round(6 * s) },
    ])
    .png()
    .toFile(`${outDir}/jefi-6.png`)
  console.log('saved', `${outDir}/jefi-6.png`)
}
process.exit(0)
