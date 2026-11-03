// A wallpaper for glass screenshots (scripts/shot-marketing.ts --glass): a borderless window filling every
// screen with the image in argv[1], kept ordered directly behind the window whose number is in the
// file argv[2] (written once the app's window is known), so the glass blurs the wallpaper and nothing else.
//
//   swift scripts/native/wallpaper-window.swift <image.png> <window-number-file>
import AppKit

let args = CommandLine.arguments
guard args.count >= 3, let image = NSImage(contentsOfFile: args[1]) else { exit(1) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// One per display: the app's window opens on whichever screen macOS picks.
let windows = NSScreen.screens.map { screen -> NSWindow in
  let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
  let view = NSImageView(frame: NSRect(origin: .zero, size: screen.frame.size))
  view.image = image
  view.imageScaling = .scaleAxesIndependently
  window.contentView = view
  window.ignoresMouseEvents = true
  window.hasShadow = false
  // Up front before the app launches, so its window opens directly on top of this one.
  window.orderFrontRegardless()
  return window
}

Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
  guard let text = try? String(contentsOfFile: args[2], encoding: .utf8), let target = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
  for window in windows { window.order(.below, relativeTo: target) }
}
print("ready")
fflush(stdout)
app.run()
