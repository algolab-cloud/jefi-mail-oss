import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The Dock icon PNG for an accent: `brand/app-icon/` from source, `Contents/Resources/` inside
 * Jefi.app. Falls back to the default icon when `bun run brand` has not produced the themed one.
 */
export function dockIconPath(accent: string): string {
  const packaged = process.execPath.includes('.app/Contents/MacOS')
  const dir = packaged ? `${dirname(process.execPath)}/../Resources` : `${import.meta.dir}/../brand/app-icon`
  const themed = `${dir}/icon-${accent}-1024.png`
  return existsSync(themed) ? themed : `${dir}/icon-1024.png`
}

/**
 * AppKit through bun:ffi: `objc_msgSend` at the arities used here, plus class and selector lookup.
 * Null off macOS, and from any runtime without bun:ffi — everything below is best effort.
 */
function appKit() {
  if (process.platform !== 'darwin') return null
  try {
    const { dlopen, CFunction, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const objc = dlopen('/usr/lib/libobjc.A.dylib', {
      objc_getClass: { args: ['cstring'], returns: 'ptr' },
      sel_registerName: { args: ['cstring'], returns: 'ptr' },
      objc_msgSend: { args: [], returns: 'ptr' },
    })
    dlopen('/System/Library/Frameworks/AppKit.framework/AppKit', { NSApplicationLoad: { args: [], returns: 'bool' } })
    const send = (objc.symbols.objc_msgSend as unknown as { ptr: import('bun:ffi').Pointer }).ptr
    const msg0 = CFunction({ ptr: send, args: ['ptr', 'ptr'], returns: 'ptr' })
    const msg1 = CFunction({ ptr: send, args: ['ptr', 'ptr', 'ptr'], returns: 'ptr' })
    const cstr = (s: string) => ptr(Buffer.from(`${s}\0`, 'utf8'))
    const cls = (name: string) => objc.symbols.objc_getClass(cstr(name))
    const sel = (name: string) => objc.symbols.sel_registerName(cstr(name))
    const string = (value: string) => msg1(cls('NSString'), sel('stringWithUTF8String:'), cstr(value))
    return { msg0, msg1, cstr, cls, sel, string }
  } catch {
    return null
  }
}

/**
 * Sets the running app's Dock icon. From source (`bun run dev`) macOS would otherwise show Bun's;
 * in Jefi.app it replaces the Info.plist icon while the app runs, so the Dock follows the accent.
 * Finder and Launchpad keep the bundle icon. Best effort: any failure leaves the icon unchanged.
 */
export function applyDockIcon(pngPath: string) {
  const kit = appKit()
  if (!kit) return
  try {
    const image = kit.msg1(kit.msg0(kit.cls('NSImage'), kit.sel('alloc')), kit.sel('initWithContentsOfFile:'), kit.string(pngPath))
    if (!image) return
    const app = kit.msg0(kit.cls('NSApplication'), kit.sel('sharedApplication'))
    kit.msg1(app, kit.sel('setApplicationIconImage:'), image)
  } catch {}
}

/**
 * The unread count on the Dock icon, as macOS draws it on the tile. An empty string clears the
 * badge. Best effort, like the icon above.
 */
export function applyDockBadge(label: string) {
  const kit = appKit()
  if (!kit) return
  try {
    const app = kit.msg0(kit.cls('NSApplication'), kit.sel('sharedApplication'))
    kit.msg1(kit.msg0(app, kit.sel('dockTile')), kit.sel('setBadgeLabel:'), kit.string(label))
  } catch {}
}
