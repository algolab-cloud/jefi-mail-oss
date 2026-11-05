// Native check for scroll forwarding (JefiMailWebView in scripts/native/mail-snapshot.m): the app's
// web view is the view AppKit sends scrolling to over a message, and with forwarding on it hands
// vertical scrolling to the window's own view (GPUIX, which scrolls the reader). Horizontal
// scrolling, and all scrolling with forwarding off, stays with the page.
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
typealias Forward = @convention(c) (UnsafeMutableRawPointer?, Bool) -> Void
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

forward(pointer, true)
host.scrolls = 0
web.scrollWheel(with: wheel(dx: 0, dy: -40))
expect("with the message fitted, vertical scrolling reaches the window's view", host.scrolls == 1)

host.scrolls = 0
web.scrollWheel(with: wheel(dx: -40, dy: 0))
expect("horizontal scrolling stays with the page", host.scrolls == 0)

forward(pointer, false)
host.scrolls = 0
web.scrollWheel(with: wheel(dx: 0, dy: -40))
expect("with forwarding off (a message too long to fit) the page keeps it", host.scrolls == 0)

print(failures.isEmpty ? "PASS mail-scroll-forward" : "FAILED: \(failures.joined(separator: "; "))")
exit(failures.isEmpty ? 0 : 1)
