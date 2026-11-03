import { alloc, available, cls, fromNSString, loadAppKit, msg, msgAddSubview, msgBool, msgGetValue, msgIndex, msgInt, msgLong, msgRectReturn, nsString } from './objc'
import { APP_NAME } from '../version'

// ---------------------------------------------------------------------------
// Liquid Glass behind the main window. GPUIX's "blurred" window strips the tint and saturation layers
// off its NSVisualEffectView, and on current macOS that leaves no blur at all, just a see-through
// window. So Jefi opens the window "transparent" and puts its own effect view under the content.
// ---------------------------------------------------------------------------

const MATERIAL_SIDEBAR = 7
const BLENDING_BEHIND_WINDOW = 0
const STATE_ACTIVE = 1
const RESIZE_WIDTH_AND_HEIGHT = 2 | 16
const NS_WINDOW_BELOW = -1
/** Names the view so a hot reload finds it instead of stacking another. */
const GLASS_ID = 'jefi.window-glass'

function mainContentView() {
  const windows = msg(msg(cls('NSApplication'), 'sharedApplication'), 'windows')
  const count = msgInt(windows, 'count')
  for (let i = 0; i < count; i++) {
    const window = msgIndex(windows, 'objectAtIndex:', i)
    if (fromNSString(msg(window, 'title')) === APP_NAME) return msg(window, 'contentView')
  }
  return null
}

/** Adds the blur under the window's content; true once it's there (again on a hot reload is a no-op). */
export function installWindowGlass(): boolean {
  if (!available) return false
  loadAppKit()
  const content = mainContentView()
  if (!content) return false
  const subviews = msg(content, 'subviews')
  for (let i = 0; i < msgInt(subviews, 'count'); i++) {
    const identifier = msg(msgIndex(subviews, 'objectAtIndex:', i), 'identifier')
    if (identifier && fromNSString(identifier) === GLASS_ID) return true
  }
  const value = msg(content, 'valueForKey:', nsString('bounds'))
  const bounds = new Float64Array(4)
  if (value) msgGetValue(value, 'getValue:size:', new Uint8Array(bounds.buffer))
  const view = msgRectReturn(alloc('NSVisualEffectView'), 'initWithFrame:', 0, 0, bounds[2] || 1440, bounds[3] || 900)
  if (!view) return false
  msgLong(view, 'setMaterial:', MATERIAL_SIDEBAR)
  msgLong(view, 'setBlendingMode:', BLENDING_BEHIND_WINDOW)
  msgLong(view, 'setState:', STATE_ACTIVE)
  msgLong(view, 'setAutoresizingMask:', RESIZE_WIDTH_AND_HEIGHT)
  msg(view, 'setIdentifier:', nsString(GLASS_ID))
  msgBool(view, 'setWantsLayer:', true)
  msgAddSubview(content, view, NS_WINDOW_BELOW, null)
  return true
}
