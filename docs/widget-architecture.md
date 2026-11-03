# WidgetKit widget for Jefi: architecture spike (lume-d6u, phase 2)

**Verdict: GO.** A SwiftUI WidgetKit extension builds with plain `swiftc` (no Xcode project), embeds
at `Jefi.app/Contents/PlugIns/JefiWidget.appex`, and was registered by PluginKit under the
`com.apple.widgetkit-extension` point. This worked with both an ad-hoc signature and a Developer ID
signature. It fits the way `scripts/bundle.ts` already builds and packages native helpers.

Prototype: `tmp/widget-proto/` in the widget-spike worktree (Widget.swift, Host.swift, widget.entitlements).
`tmp/` is gitignored, so none of it is committed.

## Toolchain evidence (this machine, 2026-09-26)

- `xcode-select -p`: `/Applications/Xcode.app/Contents/Developer`
- `xcodebuild -version`: Xcode 27.0 (27A266a)
- `swiftc --version`: Apple Swift 6.4, target arm64-apple-macosx27.0
- SDKs: macOS 27.0. Host OS: macOS 27.0.
- Signing identity: a `Developer ID Application` certificate; its Team ID is set as `APPLE_TEAM_ID`
- CI: `release.yml` runs on `blacksmith-6vcpu-macos-15`. Those images ship full Xcode. The same is
  true of GitHub's `macos-15` images, where Xcode 16.x includes WidgetKit and SwiftUI. To build we
  only need `swiftc` plus the macOS SDK. Pin the version with `DEVELOPER_DIR` or `xcode-select`.

## 1. Building the extension without an Xcode project

This compiled and linked with no errors:

```sh
swiftc -O -target arm64-apple-macos14 -parse-as-library -application-extension \
  -Xlinker -e -Xlinker _NSExtensionMain Widget.swift -o JefiWidget.appex/Contents/MacOS/JefiWidget
```

- `-e _NSExtensionMain` is the entry point Xcode uses for extensions. The `@main Widget` struct is
  discovered by WidgetKit.
- The appex `Info.plist` needs:
  - `CFBundlePackageType = XPC!`
  - `CFBundleIdentifier = app.jefi.mail.widget`. This must be prefixed by the parent id `app.jefi.mail`.
  - `CFBundleExecutable`, `CFBundleVersion` and `CFBundleShortVersionString`. These should match the app's version.
  - `LSMinimumSystemVersion = 14.0`. `containerBackground` needs 14. The widget can have a higher
    minimum than the app, which is 13.0.
  - `NSExtension = { NSExtensionPointIdentifier = com.apple.widgetkit-extension }`. There is no
    principal class; that is SwiftUI `@main`.
- The containing app needs no special keys to host the widget. It needs `CFBundleURLTypes` for deep
  links (section 3).
- Evidence: after `lsregister -f -R` and launching the host once, `pluginkit -mAvvv -i app.jefi.proto.widget`
  listed `SDK = com.apple.widgetkit-extension` and `Parent Bundle = …/JefiProto.app`. The result was the same
  ad-hoc (`codesign -s -`) and Developer ID with hardened runtime (not notarized; `spctl` rejects it as
  "Unnotarized Developer ID", which is expected).
- **Not verified:** I did not visually confirm that the widget appears in the Edit Widgets gallery.
  The spike ran with no UI access, and chronod logged nothing for the proto within 2 minutes. PluginKit
  registration is the prerequisite for the gallery. From experience, ad-hoc local builds do appear in the
  gallery once the app has launched from /Applications or ~/Applications. Sometimes `killall chronod`
  or a logout is needed first. One manual check is left for the user: build, copy to /Applications,
  launch, then right-click the desktop and choose Edit Widgets.
- Alternative: a Swift Package or tiny generated `.xcodeproj` built with `xcodebuild` is possible but
  unnecessary. swiftc keeps it in line with the existing `clang` helper builds in `bundle.ts`.

## 2. Data sharing

- **Widget extensions must be sandboxed** (`com.apple.security.app-sandbox = true`). PluginKit will
  not launch an unsandboxed widget. The widget cannot read `~/.config/jefi` or talk to the Bun process.
- **App Group:** use the macOS-style, team-prefixed group `6DQ243QTY2.app.jefi.mail`. It lives in the
  `com.apple.security.application-groups` entitlement on **both** the widget and Jefi's main binary.
  A macOS team-prefixed group does **not** need a provisioning profile with Developer ID. The
  `group.`-prefixed (iOS-style) form does need a profile, so avoid it. On macOS 15+ the OS
  shows the "would like to access data from other apps" prompt only when the accessing process is
  *not* entitled for the group. Both of our processes are entitled, so there is no prompt. That
  requires the team ID in the signature to match: ad-hoc builds cannot prove team membership, so
  local dev builds should be signed with the Apple Development or Developer ID cert when testing the
  shared container.
- Jefi is **not sandboxed**, so it can write directly to
  `~/Library/Group Containers/6DQ243QTY2.app.jefi.mail/widget.json`. Write atomically (write a
  temporary file, then rename). The widget reads it through
  `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`, as the prototype's Provider does.
- Payload (small, versioned): `{ v:1, updatedAt, unread, accounts:[{id,name,unread}], events:[{id,title,start,end,calendarColor}] }`.
  The widget computes "up next" from the event list and emits timeline entries at event boundaries,
  so it stays correct without the app running.
- **Reload trigger:** Bun cannot call Swift directly. Add `scripts/native/widget.m` (or `.swift`)
  that builds `libJefiWidget.dylib` exporting `void jefi_widget_reload(void)`. WidgetCenter is
  Swift-only, so the simplest approach is a ~10-line Swift file compiled with
  `swiftc -emit-library` that exposes `@_cdecl("jefi_widget_reload")` and calls
  `WidgetCenter.shared.reloadAllTimelines()`. Load it with `dlopen` like `src/native/notify.ts`.
  Call it debounced (for example at most once every 30s) after unread or agenda changes. The system
  budgets reloads, and reloads from a foreground app are free.

## 3. Deep links

- Jefi registers **no URL scheme today**. `scripts/bundle.ts` has no `CFBundleURLTypes`, and nothing in
  `src/` handles `kAEGetURL` or `application:openURLs:`.
- Widget side: `.widgetURL(URL("jefi://inbox"))` for small widgets, and `Link(destination: jefi://event/<id>)`
  per row in medium/large widgets. The prototype uses `widgetURL`.
- App side:
  - Add `CFBundleURLTypes = [{ CFBundleURLName: 'app.jefi.mail', CFBundleURLSchemes: ['jefi'] }]`
    in `bundle.ts`. Note that the plist writer there only handles string and bool values today, so
    it needs array and dict support.
  - Receive the URL through an Apple Event handler (`NSAppleEventManager
    setEventHandler:andSelector:forEventClass:kInternetEventClass andEventID:kAEGetURL`). It must be
    installed before `applicationDidFinishLaunching` so cold launches from a tap are caught. This fits
    the ObjC bridge in `src/native/objc.ts`: it can already allocate a class and add a method with
    `JSCallback`. A native helper is safer for the timing, because GPUIX owns NSApplication startup.
    Check whether GPUIX exposes a hook or open-URL callback first.
  - Route `jefi://event/<id>` to the calendar event view and `jefi://inbox[/<accountId>]` to the inbox.
  - Treat the URL as untrusted input: other apps can open it too, so it gets navigation only and never
    triggers an action.

## 4. Signing, notarization, CI

- `scripts/release/sign.ts` signs inside-out today (dylibs, then the binary, then the app) and does
  not use `--deep`, which is correct. Add the appex **before** the app:
  `codesign --force --timestamp --options runtime --entitlements scripts/release/widget.entitlements --sign <id> Jefi.app/Contents/PlugIns/JefiWidget.appex`
- `widget.entitlements`: `app-sandbox`, `application-groups [6DQ243QTY2.app.jefi.mail]`.
  Network is not needed.
- The main app's `entitlements.plist` gains `com.apple.security.application-groups`, alongside the
  existing JIT and executable-memory keys. The app stays unsandboxed.
- Hardcoding the team ID: read it from the signing identity in `sign.ts`, or keep a
  `TEAM_ID = '6DQ243QTY2'` constant. The group string must also be baked into Widget.swift, which
  can be templated at build time.
- Notarization covers nested bundles automatically. `codesign --verify --deep --strict` in `sign.ts`
  already validates the nested appex.
- CI: the swiftc build runs in `bundle.ts`, so `release.yml` needs no new steps if Xcode is present
  on the runner (it is on macos-15 images). Optionally add `sudo xcode-select -s /Applications/Xcode_16.x.app`
  to pin the version.

## Task breakdown

1. **Widget target build**: add `native/widget/JefiWidget.swift` and the Info.plist generation.
   `bundle.ts` compiles it with swiftc into `Contents/PlugIns/JefiWidget.appex`. It covers small and
   medium families, with unread count and up next or today's agenda from `widget.json`, and a
   placeholder or empty state.
2. **Shared snapshot writer and reload bridge**: add a `libJefiWidget.dylib` exposing
   `jefi_widget_reload` and `src/native/widget.ts` (dlopen, write atomically to the group container,
   debounced reload). Hook it into the unread-count and calendar stores. Add tests for the payload
   builder.
3. **URL scheme and deep-link routing**: add `CFBundleURLTypes` (`jefi`) in `bundle.ts` and extend
   the plist writer for arrays and dicts. Add a kAEGetURL handler that works on cold and warm launch,
   and a router for `jefi://inbox` and `jefi://event/<id>`, with tests for URL parsing.
4. **Signing and release**: add `scripts/release/widget.entitlements`, and the app-groups entitlement
   on the main app. `sign.ts` signs the appex first. Verify with a notarized dry run and that
   `pluginkit -m -p com.apple.widgetkit-extension` lists `app.jefi.mail.widget`.
5. **Manual QA on a clean Mac**: install from the DMG and confirm:
   - The widget is in the gallery, on the desktop and in Notification Center.
   - There is no group container prompt.
   - Taps open the right view.

## Needs the user

- Confirm Team ID **6DQ243QTY2** (from the Developer ID cert) and the group id
  `6DQ243QTY2.app.jefi.mail`. No Developer Portal change should be needed: team-prefixed macOS groups
  work with Developer ID without a profile. If macOS 27 disagrees during QA, register an App Group
  and a Developer ID provisioning profile for `app.jefi.mail` and `app.jefi.mail.widget` in the portal.
- Do the one visual check of the gallery (section 1).
