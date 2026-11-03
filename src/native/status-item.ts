import markSvg from '../assets/brand/mark.svg' with { type: 'text' }
import type { Pointer } from 'bun:ffi'
import { alloc, available, cls, makeObject, msg, msgBool, msgBoolResult, msgDoubleReturn, msgGetValue, msgLong, msgRectObj, msgRectReturn, msgSize, nsString, sel, type Id } from './objc'
import { APP_NAME } from '../version'

// ---------------------------------------------------------------------------
// Jefi's item in the menu bar: the mark as a template image (macOS tints it for light and dark bars
// and for the pressed state), with optional short text beside it. The click comes back on the main
// thread through the run loop GPUIX pumps, like every other AppKit action here.
// ---------------------------------------------------------------------------

const VARIABLE_LENGTH = -1
const IMAGE_LEFT = 2
/** The mark's height in the bar, in points; menu bar symbols sit around 14–16pt. */
const MARK_HEIGHT = 11

export type StatusItem = { button: Id; setTitle: (title: string) => void; click: () => void; screenFrame: () => { x: number; y: number; width: number; height: number } | null; snapshot: (path: string) => boolean; remove: () => void }

/** An object's frame through KVC (an NSValue), read without a struct-return call: [x, y, width, height]. */
function rectOf(object: Id, key = 'frame'): number[] | null {
  const value = object && msg(object, 'valueForKey:', nsString(key))
  if (!value) return null
  const bytes = new Float64Array(4)
  msgGetValue(value, 'getValue:size:', new Uint8Array(bytes.buffer))
  return [...bytes]
}

let clickHandler: (() => void) | null = null

/** The mark as a template NSImage, from the same SVG the app draws (the artwork is solid black on clear). */
function markImage(): Id {
  const bytes = Buffer.from(markSvg)
  const data = msg(cls('NSData'), 'dataWithBytes:length:', bytes as unknown as Pointer, bytes.length as unknown as Pointer)
  const image = msg(alloc('NSImage'), 'initWithData:', data)
  if (!image) return null
  const [, , width, height] = markSvg.match(/viewBox="([^"]+)"/)![1]!.split(/\s+/).map(Number)
  msgSize(image, 'setSize:', (MARK_HEIGHT * width!) / height!, MARK_HEIGHT)
  return image
}

/** Adds the item. Null off macOS or if AppKit refuses; the app works the same without it. */
export function createStatusItem(onClick: () => void): StatusItem | null {
  if (!available) return null
  try {
    clickHandler = onClick
    const item = msgDoubleReturn(msg(cls('NSStatusBar'), 'systemStatusBar'), 'statusItemWithLength:', VARIABLE_LENGTH)
    if (!item) return null
    msg(item, 'retain')
    // Lets macOS remember where the person Cmd-dragged it.
    msg(item, 'setAutosaveName:', nsString('JefiMenuBar'))
    const button = msg(item, 'button')!
    const image = markImage() ?? msg(cls('NSImage'), 'imageWithSystemSymbolName:accessibilityDescription:', nsString('envelope'), nsString(APP_NAME))
    msgBool(image, 'setTemplate:', true)
    msg(button, 'setImage:', image)
    msgLong(button, 'setImagePosition:', IMAGE_LEFT)
    msg(button, 'setToolTip:', nsString(APP_NAME))
    const target = makeObject('JefiStatusItemTarget', null, [{ selector: 'clicked:', types: 'v@:@', args: 1, fn: () => clickHandler?.() }])
    msg(button, 'setTarget:', target)
    msg(button, 'setAction:', sel('clicked:'))
    let shown = ''
    return {
      button,
      setTitle(title) {
        if (title === shown) return
        shown = title
        // A leading space keeps the text off the mark; empty leaves the icon alone.
        msg(button, 'setTitle:', nsString(title ? ` ${title}` : ''))
      },
      click: () => void msg(button, 'performClick:', null),
      screenFrame: () => {
        const frame = rectOf(msg(button, 'window'))
        const screen = rectOf(msg(cls('NSScreen'), 'mainScreen'))
        return frame && screen ? { x: frame[0], y: screen[3] - frame[1] - frame[3], width: frame[2], height: frame[3] } : null
      },
      snapshot(path) {
        // The button drawn into a bitmap, for scripts: on a crowded notched bar the item itself can
        // sit under the notch, where screencapture sees nothing.
        const bounds = rectOf(button, 'bounds')
        if (!bounds) return false
        const rep = msgRectReturn(button, 'bitmapImageRepForCachingDisplayInRect:', 0, 0, bounds[2]!, bounds[3]!)
        if (!rep) return false
        msgRectObj(button, 'cacheDisplayInRect:toBitmapImageRep:', 0, 0, bounds[2]!, bounds[3]!, rep)
        return msgBoolResult(msg(rep, 'TIFFRepresentation'), 'writeToFile:atomically:', nsString(path), 1 as unknown as Pointer)
      },
      remove() {
        clickHandler = null
        msg(msg(cls('NSStatusBar'), 'systemStatusBar'), 'removeStatusItem:', item)
        msg(item, 'release')
      },
    }
  } catch {
    return null
  }
}
