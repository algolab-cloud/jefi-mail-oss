// Prints the number and screen bounds (x y width height, in points) of the on-screen window titled argv[1] that belongs to a process named argv[2]
// (scripts/shot-marketing.ts --glass finds the app's window this way to capture it from the screen).
//
//   swift scripts/native/window-number.swift Jefi bun
import CoreGraphics

let args = CommandLine.arguments
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for window in list where (window[kCGWindowLayer as String] as? Int) == 0 {
  if window[kCGWindowName as String] as? String == args[1], window[kCGWindowOwnerName as String] as? String == args[2] {
    let b = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    print(window[kCGWindowNumber as String]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!)
    break
  }
}
