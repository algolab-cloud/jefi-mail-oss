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
let host = Host(frame: NSRect(x: 0, y: 0, width: 600, height: 500))
window.contentView = host
// As in mail-webview.ts: a clipping view on the window's view, the web view inside it.
let clip = NSView(frame: NSRect(x: 50, y: 50, width: 400, height: 300))
let web = webClass.init(frame: clip.bounds, configuration: WKWebViewConfiguration())
clip.addSubview(web)
host.addSubview(clip)
web.loadHTMLString("<p>Short message</p>", baseURL: nil)
window.orderFrontRegardless()
let until = Date().addingTimeInterval(1)
while Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }

func wheel(dx: Int32, dy: Int32) -> NSEvent {
  NSEvent(cgEvent: CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)!)!
}
var failures: [String] = []
func expect(_ name: String, _ ok: Bool) {
  print("\(ok ? "ok  " : "FAIL") \(name)")
  if !ok { failures.append(name) }
}
let pointer = Unmanaged.passUnretained(web).toOpaque()

expect("AppKit sends scrolling over the message to the web view", host.hitTest(NSPoint(x: 250, y: 200)) === web)

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
