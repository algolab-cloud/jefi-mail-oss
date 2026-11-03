import { CFunction, CString, dlopen, FFIType, JSCallback, ptr, read, type Pointer } from 'bun:ffi'

// ---------------------------------------------------------------------------
// A minimal Objective-C bridge over Bun FFI: enough to drive a few AppKit/WebKit objects from
// the UI thread without shipping any native code. macOS only; callers check `available` first.
//
// objc_msgSend is one C symbol called with many signatures, so each shape gets its own
// CFunction over the same pointer. On arm64 a CGRect passed by value travels in d0–d3, exactly
// like four doubles, which is how frames are passed below.
// ---------------------------------------------------------------------------

export const available = process.platform === 'darwin' && process.arch === 'arm64'

type Id = Pointer | null

const lib = available
  ? {
      objc: dlopen('/usr/lib/libobjc.A.dylib', {
        objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
        sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
        objc_allocateClassPair: { args: [FFIType.ptr, FFIType.cstring, FFIType.u64], returns: FFIType.ptr },
        objc_registerClassPair: { args: [FFIType.ptr], returns: FFIType.void },
        class_addMethod: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.bool },
        class_addProtocol: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
        objc_getProtocol: { args: [FFIType.cstring], returns: FFIType.ptr },
      }),
      system: dlopen('/usr/lib/libSystem.B.dylib', { dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr } }),
    }
  : null

const cstr = (s: string) => Buffer.from(`${s}\0`)
const RTLD_DEFAULT = -2 as unknown as Pointer

let loadedWebKit = false
let loadedAppKit = false
/** Explicit for standalone native smoke tests; the desktop app already has AppKit loaded. */
export function loadAppKit() {
  if (loadedAppKit || !available) return
  dlopen('/System/Library/Frameworks/AppKit.framework/AppKit', { NSApplicationMain: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
  loadedAppKit = true
}
/** Loads WebKit into the process (AppKit is already there: GPUIX draws into an NSWindow). */
export function loadWebKit() {
  if (loadedWebKit || !available) return
  dlopen('/System/Library/Frameworks/WebKit.framework/WebKit', { WKBundlePageGetTypeID: { args: [], returns: FFIType.u64 } })
  loadedWebKit = true
}

const selectors = new Map<string, Pointer>()
export const sel = (name: string) => {
  let s = selectors.get(name)
  if (!s) selectors.set(name, (s = lib!.objc.symbols.sel_registerName(cstr(name))!))
  return s
}
export const cls = (name: string) => lib!.objc.symbols.objc_getClass(cstr(name))

const sendPtr = () => lib!.system.symbols.dlsym(RTLD_DEFAULT, cstr('objc_msgSend'))!
const shapes = new Map<string, (...args: unknown[]) => unknown>()
function shape(args: FFIType[], returns: FFIType) {
  const key = `${args.join(',')}>${returns}`
  let fn = shapes.get(key)
  if (!fn) {
    fn = CFunction({ ptr: sendPtr(), args: [FFIType.ptr, FFIType.ptr, ...args], returns }) as unknown as (...args: unknown[]) => unknown
    shapes.set(key, fn)
  }
  return fn
}

/** Sends a message whose arguments are all object pointers (or none); returns an object. */
export const msg = (target: Id, selector: string, ...args: Id[]): Id =>
  shape(args.map(() => FFIType.ptr), FFIType.ptr)(target, sel(selector), ...args) as Id
export const msgBool = (target: Id, selector: string, value: boolean) => void shape([FFIType.bool], FFIType.void)(target, sel(selector), value)
/** Sends object-pointer arguments and preserves an Objective-C BOOL result. */
export const msgBoolResult = (target: Id, selector: string, ...args: Id[]): boolean =>
  Boolean(shape(args.map(() => FFIType.ptr), FFIType.bool)(target, sel(selector), ...args))
export const msgDouble = (target: Id, selector: string, value: number) => void shape([FFIType.f64], FFIType.void)(target, sel(selector), value)
/** Sends one NSInteger/enum argument (activation policies, popover behaviours, image positions). */
export const msgLong = (target: Id, selector: string, value: number) => void shape([FFIType.i64], FFIType.void)(target, sel(selector), value)
/** Sends one CGFloat argument and returns an object (NSStatusBar's statusItemWithLength:). */
export const msgDoubleReturn = (target: Id, selector: string, value: number): Id => shape([FFIType.f64], FFIType.ptr)(target, sel(selector), value) as Id
/** Sends an NSSize (two doubles in d0–d1 on arm64). */
export const msgSize = (target: Id, selector: string, width: number, height: number) =>
  void shape([FFIType.f64, FFIType.f64], FFIType.void)(target, sel(selector), width, height)
/** NSPopover's showRelativeToRect:ofView:preferredEdge:. */
export const msgShowRelative = (target: Id, x: number, y: number, w: number, h: number, view: Id, edge: number) =>
  void shape([FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.ptr, FFIType.u64], FFIType.void)(target, sel('showRelativeToRect:ofView:preferredEdge:'), x, y, w, h, view, edge)
/** NSView's addSubview:positioned:relativeTo: (NSWindowBelow = -1, NSWindowAbove = 1). */
export const msgAddSubview = (target: Id, view: Id, place: number, relativeTo: Id) =>
  void shape([FFIType.ptr, FFIType.i64, FFIType.ptr], FFIType.void)(target, sel('addSubview:positioned:relativeTo:'), view, place, relativeTo)
export const msgInt = (target: Id, selector: string): number => Number(shape([], FFIType.i64)(target, sel(selector), ...[]))
export const msgIndex = (target: Id, selector: string, index: number): Id => shape([FFIType.u64], FFIType.ptr)(target, sel(selector), index) as Id
/** Copies an NSValue's bytes (for example an NSPoint boxed by KVC) without relying on struct-return ABI. */
export const msgGetValue = (target: Id, selector: string, destination: Uint8Array) =>
  void shape([FFIType.ptr, FFIType.u64], FFIType.void)(target, sel(selector), ptr(destination), destination.byteLength)
export const msgRect = (target: Id, selector: string, x: number, y: number, w: number, h: number) =>
  void shape([FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64], FFIType.void)(target, sel(selector), x, y, w, h)
/** Sends a CGRect argument and returns the initialized object. */
export const msgRectReturn = (target: Id, selector: string, x: number, y: number, w: number, h: number): Id =>
  shape([FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64], FFIType.ptr)(target, sel(selector), x, y, w, h) as Id
export const msgRectObj = (target: Id, selector: string, x: number, y: number, w: number, h: number, obj: Id): Id =>
  shape([FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.ptr], FFIType.ptr)(target, sel(selector), x, y, w, h, obj) as Id
/** NSWindow's initWithContentRect:styleMask:backing:defer:. */
export const msgInitWindow = (target: Id, x: number, y: number, w: number, h: number, styleMask: number, backing: number): Id =>
  shape([FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.u64, FFIType.u64, FFIType.bool], FFIType.ptr)(
    target,
    sel('initWithContentRect:styleMask:backing:defer:'),
    x, y, w, h, styleMask, backing, false,
  ) as Id

export const nsString = (s: string): Id => msg(cls('NSString'), 'stringWithUTF8String:', cstr(s) as unknown as Pointer)
export const fromNSString = (s: Id): string => {
  if (!s) return ''
  const utf8 = msg(s, 'UTF8String')
  return utf8 ? new CString(utf8).toString() : ''
}
export const alloc = (className: string) => msg(cls(className), 'alloc')
export const release = (obj: Id) => void (obj && msg(obj, 'release'))

/** Calls an Objective-C block that takes one integer (e.g. a WKNavigation decision handler). */
export function callBlockWithInt(block: Pointer, value: number) {
  const invoke = read.ptr(block, 16) as unknown as Pointer
  CFunction({ ptr: invoke, args: [FFIType.ptr, FFIType.i64], returns: FFIType.void })(block, value)
}

const keepAlive: JSCallback[] = []
/**
 * Defines an NSObject subclass at runtime with the given methods (implemented in JS) and
 * returns a new instance. Every method receives (self, _cmd, ...pointer args).
 */
export function makeObject(className: string, protocol: string | null, methods: Array<{ selector: string; types: string; args: number; fn: (...args: Pointer[]) => void }>): Id {
  let klass = cls(className)
  if (!klass) {
    klass = lib!.objc.symbols.objc_allocateClassPair(cls('NSObject'), cstr(className), 0)!
    for (const method of methods) {
      const callback = new JSCallback((...args: Pointer[]) => method.fn(...args), {
        args: Array.from({ length: method.args + 2 }, () => FFIType.ptr),
        returns: FFIType.void,
      })
      keepAlive.push(callback)
      lib!.objc.symbols.class_addMethod(klass, sel(method.selector), callback.ptr!, cstr(method.types))
    }
    if (protocol) {
      const proto = lib!.objc.symbols.objc_getProtocol(cstr(protocol))
      if (proto) lib!.objc.symbols.class_addProtocol(klass, proto)
    }
    lib!.objc.symbols.objc_registerClassPair(klass)
  }
  return msg(msg(klass, 'alloc'), 'init')
}
