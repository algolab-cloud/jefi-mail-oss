// Throwaway spike (lume-d6u): NSStatusItem + NSPopover(WKWebView) + hide-on-close inside a GPUIX app.
// Run: bun docs/menu-bar-prototype.tsx  (writes tmp/menubar-proto.log and tmp/*.png)
import { appendFileSync, writeFileSync } from 'node:fs'
import { CFunction, CString, dlopen, FFIType, JSCallback, type Pointer } from 'bun:ffi'
import { GpuixRenderer, render } from '@gpuix/react'
import { alloc, cls, fromNSString, loadWebKit, makeObject, msg, msgBool, msgInt, msgIndex, msgRectObj, nsString, sel } from '../src/native/objc'

const LOG = `${import.meta.dir}/../tmp/menubar-proto.log`
writeFileSync(LOG, '')
const log = (line: string) => {
  appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

const objc = dlopen('/usr/lib/libobjc.A.dylib', {
  object_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
  class_getName: { args: [FFIType.ptr], returns: FFIType.ptr },
  class_replaceMethod: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
})
const sys = dlopen('/usr/lib/libSystem.B.dylib', { dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr } })
const send = sys.symbols.dlsym(-2 as unknown as Pointer, Buffer.from('objc_msgSend\0'))!
const fn = (args: FFIType[], returns: FFIType) => CFunction({ ptr: send, args: [FFIType.ptr, FFIType.ptr, ...args], returns })
const msgF64Ret = fn([FFIType.f64], FFIType.ptr)
const msgI64 = fn([FFIType.i64], FFIType.void)
const msgSize = fn([FFIType.f64, FFIType.f64], FFIType.void)
const msgShowPopover = fn([FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.ptr, FFIType.u64], FFIType.void)
const className = (o: Pointer | null) => new CString(objc.symbols.class_getName(objc.symbols.object_getClass(o))!).toString()

const app = () => msg(cls('NSApplication'), 'sharedApplication')
const mainWindow = () => {
  const windows = msg(app(), 'windows')
  for (let i = 0; i < msgInt(windows, 'count'); i++) {
    const w = msgIndex(windows, 'objectAtIndex:', i)
    if (className(w) !== 'NSStatusBarWindow' && !className(w).includes('Popover')) return w
  }
  return null
}

render(
  <div style={{ width: '100%', height: '100%', backgroundColor: '#1d1f24', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <text style={{ color: '#fff', fontSize: 20 }}>GPUIX main window (menu bar spike)</text>
  </div>,
  { title: 'Spike', appName: 'Spike', width: 700, height: 400, titlebarTransparent: true },
)

// Q2a: a second native renderer in the same process.
try {
  new GpuixRenderer(() => {}).init({ title: 'second', width: 300, height: 300 })
  log('second GpuixRenderer: OK')
} catch (error) {
  log(`second GpuixRenderer: ${(error as Error).message}`)
}

let popover: Pointer | null = null
let statusButton: Pointer | null = null

function buildPopover() {
  loadWebKit()
  const config = msg(alloc('WKWebViewConfiguration'), 'init')
  const controller = msg(config, 'userContentController')
  const handler = makeObject('SpikeMenuBarMessages', 'WKScriptMessageHandler', [
    {
      selector: 'userContentController:didReceiveScriptMessage:',
      types: 'v@:@@',
      args: 2,
      fn: (_s, _c, _ucc, message) => log(`webview -> js: ${fromNSString(msg(message, 'body'))} (main thread: ${msgInt(cls('NSThread'), 'isMainThread')})`),
    },
  ])
  msg(controller, 'addScriptMessageHandler:name:', handler, nsString('jefi'))
  const web = msgRectObj(alloc('WKWebView'), 'initWithFrame:configuration:', 0, 0, 340, 420, config)
  // Transparent page so the popover's own vibrant material shows through.
  msg(web, 'setValue:forKey:', msg(cls('NSNumber'), 'numberWithBool:', null), nsString('drawsBackground'))
  const html = `<!doctype html><html><head><style>
    :root{color-scheme:light dark;font:13px -apple-system}
    body{margin:0;padding:14px;background:transparent}
    h1{font-size:11px;text-transform:uppercase;opacity:.6;margin:12px 0 6px}
    .next{font-size:15px;font-weight:600} .row{padding:6px 8px;border-radius:6px} .row:hover{background:rgba(127,127,127,.18)}
    button{margin-right:6px}
  </style></head><body>
    <div class="next">Board dry run</div><div>in 25m · 14:30–15:00</div>
    <h1>Today</h1><div class="row">09:00 Standup</div><div class="row">14:30 Board dry run</div>
    <h1>Recent</h1><div class="row" onclick="webkit.messageHandlers.jefi.postMessage('open:thread-1')">New mail from Ana: Q3 numbers</div>
    <h1>Quick</h1><button onclick="webkit.messageHandlers.jefi.postMessage('compose')">Compose</button><button>New event</button>
    <script>webkit.messageHandlers.jefi.postMessage('loaded')</script>
  </body></html>`
  msg(web, 'loadHTMLString:baseURL:', nsString(html), null)
  const vc = msg(alloc('NSViewController'), 'init')
  msg(vc, 'setView:', web)
  popover = msg(alloc('NSPopover'), 'init')
  msgI64(popover, sel('setBehavior:'), 1) // NSPopoverBehaviorTransient: closes on outside click / Esc
  msgSize(popover, sel('setContentSize:'), 340, 420)
  msg(popover, 'setContentViewController:', vc)
}

function togglePopover() {
  if (!popover) buildPopover()
  if (msgInt(popover, 'isShown')) return void msg(popover, 'performClose:', null)
  // NSZeroRect: position against the button's bounds. NSMinYEdge = 1 (below, flipped status bar).
  msgShowPopover(popover, sel('showRelativeToRect:ofView:preferredEdge:'), 0, 0, 0, 0, statusButton, 1)
  msg(app(), 'activateIgnoringOtherApps:', null)
  log(`popover shown: ${msgInt(popover, 'isShown')}`)
}

function installStatusItem() {
  const item = msgF64Ret(msg(cls('NSStatusBar'), 'systemStatusBar'), sel('statusItemWithLength:'), -1)
  msg(item, 'retain')
  statusButton = msg(item, 'button')
  const image = msg(cls('NSImage'), 'imageWithSystemSymbolName:accessibilityDescription:', nsString('envelope.fill'), nsString('Jefi'))
  msgBool(image, 'setTemplate:', true)
  msg(statusButton, 'setImage:', image)
  msgI64(statusButton, sel('setImagePosition:'), 2) // NSImageLeft
  msg(statusButton, 'setTitle:', nsString(' Board dry run in 25m'))
  const target = makeObject('SpikeStatusTarget', null, [
    { selector: 'clicked:', types: 'v@:@', args: 1, fn: () => { log(`status item clicked (main thread: ${msgInt(cls('NSThread'), 'isMainThread')})`); togglePopover() } },
  ])
  msg(statusButton, 'setTarget:', target)
  msg(statusButton, 'setAction:', sel('clicked:') as Pointer)
  log(`status item: ${className(item)}, button ${className(statusButton)}`)
}

const keep: JSCallback[] = []
function hideInsteadOfClose(window: Pointer) {
  const delegate = msg(window, 'delegate')
  const delegateClass = objc.symbols.object_getClass(delegate)
  log(`window ${className(window)} delegate ${className(delegate)}`)
  const shouldClose = new JSCallback(
    (_self: Pointer, _cmd: Pointer, sender: Pointer) => {
      msg(sender, 'orderOut:', null)
      log('windowShouldClose: -> hid window, returned NO')
      return false
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  )
  keep.push(shouldClose)
  const previous = objc.symbols.class_replaceMethod(delegateClass, sel('windowShouldClose:'), shouldClose.ptr!, Buffer.from('c@:@\0'))
  log(`replaced windowShouldClose: (had previous impl: ${previous != null})`)

  const appDelegate = msg(app(), 'delegate')
  log(`app delegate ${className(appDelegate)}`)
  const reopen = new JSCallback(
    () => {
      msg(window, 'makeKeyAndOrderFront:', null)
      log('applicationShouldHandleReopen: -> showed window')
      return true
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.bool },
  )
  keep.push(reopen)
  const prevReopen = objc.symbols.class_replaceMethod(objc.symbols.object_getClass(appDelegate), sel('applicationShouldHandleReopen:hasVisibleWindows:'), reopen.ptr!, Buffer.from('c@:@c\0'))
  log(`replaced applicationShouldHandleReopen: (had previous impl: ${prevReopen != null})`)
}

const shot = (name: string) => Bun.spawnSync(['screencapture', '-x', `${import.meta.dir}/../tmp/${name}.png`])
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

setTimeout(async () => {
  installStatusItem()
  const window = mainWindow()!
  hideInsteadOfClose(window)
  await wait(500)
  msg(statusButton, 'performClick:', null)
  await wait(1500)
  shot('menubar-popover')
  msg(popover, 'performClose:', null)
  await wait(300)
  msg(window, 'performClose:', null)
  await wait(1000)
  log(`after performClose: visible=${msgInt(window, 'isVisible')} process alive`)
  msgI64(app(), sel('setActivationPolicy:'), 1)
  await wait(500)
  log(`activation policy now ${msgInt(app(), 'activationPolicy')} (1 = accessory, no Dock icon)`)
  shot('menubar-hidden')
  msgI64(app(), sel('setActivationPolicy:'), 0)
  msg(window, 'makeKeyAndOrderFront:', null)
  msg(app(), 'activateIgnoringOtherApps:', null)
  await wait(800)
  log(`reopened: visible=${msgInt(window, 'isVisible')} policy=${msgInt(app(), 'activationPolicy')}`)
  if (process.env.SPIKE_KEEP !== '1') process.exit(0)
}, 1500)
