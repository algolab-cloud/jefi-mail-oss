// Native check for scroll routing (JefiMailWebView in scripts/native/mail-snapshot.m): the app's web
// view is the view AppKit sends scrolling to over a message, and it hands vertical gestures to the
// window's own view (GPUIX, which scrolls the reader) when the message fits, when the page is cut off
// by the reader's edge, or when the page is already at its edge in that direction; otherwise the page
// scrolls. Horizontal gestures always stay with the page.
//
//   swiftc -O scripts/testing/mail-scroll-forward.swift -o tmp/mail-scroll-forward
//   tmp/mail-scroll-forward build/native/libJefiMailSnapshot.dylib
import AppKit
import WebKit

final class Host: NSView {
  var scrolls = 0
  override func scrollWheel(with event: NSEvent) { scrolls += 1 }
}

guard CommandLine.arguments.count > 1, let library = dlopen(CommandLine.arguments[1], RTLD_NOW),
      let symbol = dlsym(library, "jefi_mail_forward_scroll"),
      let webClass = NSClassFromString("JefiMailWebView") as? WKWebView.Type else {
  print("FAIL: couldn't load JefiMailWebView from the helper")
  exit(1)
}
typealias Forward = @convention(c) (UnsafeMutableRawPointer?, Bool, Bool) -> Void
let forward = unsafeBitCast(symbol, to: Forward.self)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 500), styleMask: [.borderless], backing: .buffered, defer: false)
// As in the app: the window's content view holds GPUIX's view and, beside it on top, the clipping view
// mail-webview.ts adds, with the web view inside. (Forwarding to the content view itself, which does
// nothing with scrolling, is how the first version of this left the reader unscrollable.)
let content = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 500))
window.contentView = content
let host = Host(frame: content.bounds)
content.addSubview(host)
let clip = NSView(frame: NSRect(x: 50, y: 50, width: 400, height: 300))
let web = webClass.init(frame: clip.bounds, configuration: WKWebViewConfiguration())
clip.addSubview(web)
content.addSubview(clip)
web.loadHTMLString("<p>Short message</p>", baseURL: nil)
window.orderFrontRegardless()
let until = Date().addingTimeInterval(1)
while Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }

/** A scroll over the middle of the page, located as a real one is: the reader view is found under it. */
func wheel(dx: Int32, dy: Int32) -> NSEvent {
  let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)!
  // Without a window, AppKit reads the location as a screen point with a bottom-left origin; the
  // window sits at the screen's origin, so this is (250, 200) in it, over the page.
  let screenHeight = NSScreen.screens.first?.frame.height ?? 0
  let origin = window.frame.origin
  cg.location = CGPoint(x: origin.x + 250, y: screenHeight - (origin.y + 200))
  return NSEvent(cgEvent: cg)!
}
var failures: [String] = []
func expect(_ name: String, _ ok: Bool) {
  print("\(ok ? "ok  " : "FAIL") \(name)")
  if !ok { failures.append(name) }
}
let pointer = Unmanaged.passUnretained(web).toOpaque()

expect("AppKit sends scrolling over the message to the web view", content.hitTest(NSPoint(x: 250, y: 200)) === web)

func routed(dx: Int32 = 0, dy: Int32) -> Bool {
  host.scrolls = 0
  web.scrollWheel(with: wheel(dx: dx, dy: dy))
  return host.scrolls == 1
}

forward(pointer, true, true)
expect("a message that fits: scrolling either way moves the conversation", routed(dy: -40) && routed(dy: 40))
expect("horizontal scrolling stays with the page", !routed(dx: -40, dy: 0))

// A long message: the page scrolls inside, starting at its top.
forward(pointer, false, true)
expect("a long message at its top: scrolling down scrolls the page", !routed(dy: -40))
expect("a long message at its top: scrolling up carries on into the conversation", routed(dy: 40))

// The page partly outside the reader (the clipping view is the visible part): bring it into view first.
clip.frame = NSRect(x: 50, y: 50, width: 400, height: 200)
web.frame = NSRect(x: 0, y: -100, width: 400, height: 300)
forward(pointer, false, true)
expect("a page cut off by the reader's edge: scrolling moves the conversation", routed(dy: -40))

print(failures.isEmpty ? "PASS mail-scroll-forward" : "FAILED: \(failures.joined(separator: "; "))")
exit(failures.isEmpty ? 0 : 1)
