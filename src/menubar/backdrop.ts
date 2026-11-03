import { alloc, available, cls, msg, msgBool, msgGetValue, msgIndex, msgInitWindow, msgInt, msgLong, msgRectReturn, nsString, type Id } from '../native/objc'

// ---------------------------------------------------------------------------
// For scripts/shot-menubar.ts only (reached through the debug remote): a borderless window over each
// screen, below the menu bar, so the panel's glass can be screenshotted over a known light, dark or
// busy backdrop, or a picture (the marketing shot's wallpaper), without touching the real wallpaper. It ignores the mouse and goes away with `none`.
// ---------------------------------------------------------------------------

export type Backdrop = 'light' | 'dark' | 'busy' | 'image' | 'none'

const BORDERLESS = 0
const BUFFERED = 2
/** NSFloatingWindowLevel: over the app's own windows, under the menu bar and the popover. */
const FLOATING = 3
/** NSMainMenuWindowLevel + 1: a picture covers the menu bar too (still under the popover), so a shot of the panel's arrow has wallpaper, not the real bar, around it. */
const OVER_MENU_BAR = 25
/** Saturated colours with near-white and near-black among them: the hardest case for text on glass. */
const BUSY = ['#FF3B30', '#FFFFFF', '#0A84FF', '#FFD60A', '#111111', '#34C759', '#FF2D92', '#F2F2F2', '#5E5CE6', '#FF9F0A', '#000000', '#64D2FF']

let windows: Id[] = []

const colour = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return msgRectReturn(cls('NSColor'), 'colorWithSRGBRed:green:blue:alpha:', r!, g!, b!, 1)
}

const frameOf = (object: Id) => {
  const value = object && msg(object, 'valueForKey:', nsString('frame'))
  const bytes = new Float64Array(4)
  if (value) msgGetValue(value, 'getValue:size:', new Uint8Array(bytes.buffer))
  return [...bytes]
}

function backdropView(kind: Exclude<Backdrop, 'none'>, w: number, h: number, image: Id) {
  const content = msgRectReturn(alloc('NSView'), 'initWithFrame:', 0, 0, w, h)!
  msgBool(content, 'setWantsLayer:', true)
  if (kind === 'image' && image) {
    // Stretched over the whole screen, so a picture rendered at the screen's size maps pixel for point.
    msg(msg(content, 'layer'), 'setContentsGravity:', nsString('resize'))
    msg(msg(content, 'layer'), 'setContents:', image)
    return content
  }
  msg(msg(content, 'layer'), 'setBackgroundColor:', msg(colour(kind === 'dark' ? '#1C1C1E' : '#F5F5F7'), 'CGColor'))
  if (kind !== 'busy') return content
  // Diagonal bands of tiles, so every part of the panel sits over a different colour.
  const size = 56
  for (let row = 0; row * size < h; row++) {
    for (let col = 0; col * size < w; col++) {
      const tile = msgRectReturn(alloc('NSView'), 'initWithFrame:', col * size, row * size, size, size)!
      msgBool(tile, 'setWantsLayer:', true)
      msg(msg(tile, 'layer'), 'setBackgroundColor:', msg(colour(BUSY[(row * 5 + col * 7) % BUSY.length]!), 'CGColor'))
      msg(content, 'addSubview:', tile)
      msg(tile, 'release')
    }
  }
  return content
}

/** One window per screen: with several displays the item, and so the panel, follows the active menu bar. */
export function showBackdrop(kind: Backdrop, imagePath?: string) {
  if (!available) return
  for (const window of windows) {
    msg(window, 'orderOut:', null)
    msg(window, 'release')
  }
  windows = []
  if (kind === 'none') return
  const image = kind === 'image' && imagePath ? msg(alloc('NSImage'), 'initWithContentsOfFile:', nsString(imagePath)) : null
  const screens = msg(cls('NSScreen'), 'screens')
  for (let i = 0; i < msgInt(screens, 'count'); i++) {
    const [x, y, w, h] = frameOf(msgIndex(screens, 'objectAtIndex:', i))
    const window = msgInitWindow(alloc('NSWindow'), x!, y!, w!, h!, BORDERLESS, BUFFERED)
    if (!window) continue
    msgBool(window, 'setReleasedWhenClosed:', false)
    msgBool(window, 'setIgnoresMouseEvents:', true)
    msgLong(window, 'setLevel:', image ? OVER_MENU_BAR : FLOATING)
    const content = backdropView(kind, w!, h!, image)
    msg(window, 'setContentView:', content)
    msg(content, 'release')
    msg(window, 'orderFrontRegardless')
    windows.push(window)
  }
  if (image) msg(image, 'release')
}
