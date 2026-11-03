# Menu bar item: architecture spike (lume-d6u)

Prototype: `docs/menu-bar-prototype.tsx` (run `bun docs/menu-bar-prototype.tsx`; it writes `tmp/menubar-proto.log` and
two full-screen screenshots to `tmp/`, then exits). Everything below marked **ran** was observed
in that run on macOS 27 / arm64 inside a live GPUIX 0.8.0 window:

```
second GpuixRenderer: A GPUI application already exists on this thread
status item: NSKVONotifying_NSSceneStatusItem, button NSStatusBarButton
window NSKVONotifying_GPUIWindow delegate NSKVONotifying_GPUIWindow
replaced windowShouldClose: (had previous impl: false)
app delegate GPUIApplicationDelegate
replaced applicationShouldHandleReopen: (had previous impl: true)
status item clicked (main thread: 1)
popover shown: 1
webview -> js: loaded (main thread: 1)
windowShouldClose: -> hid window, returned NO
after performClose: visible=0 process alive
activation policy now 1 (1 = accessory, no Dock icon)
reopened: visible=1 policy=0
```

## 1. NSStatusItem from Bun: yes (ran)

Pure `src/native/objc.ts` is enough, no `.m` helper needed:

- `[[NSStatusBar systemStatusBar] statusItemWithLength:-1]` (needs an `f64` msgSend shape, and `retain`).
- `button.image = [NSImage imageWithSystemSymbolName:…]` with `setTemplate:YES` tints correctly in
  light/dark. Our mark works the same way from a template PDF/PNG (`initWithContentsOfFile:`).
- `button.title` shows text next to the icon (`setImagePosition: NSImageLeft`).
- Clicks: `makeObject()` target with `clicked:` + `setAction:`. The callback ran on the main thread
  (same guarantee notify.ts relies on), because AppKit delivers actions from the run loop that GPUIX's
  `tick()` pumps.

Caveat seen on screen: on a notched MacBook with a crowded bar, a long title ("Board dry run in 25m")
pushed the item **under the notch, invisible**. Keep the title short/optional (icon + count by
default, countdown only inside ~15 min), and set `autosaveName` so users can Cmd-drag it.

## 2. Panel rendering: NSPopover + transparent WKWebView (ran, seen on screen)

**a. Second GPUIX window: not possible today.** `new GpuixRenderer().init()` in the running app throws
`A GPUI application already exists on this thread`. `WindowOptions` has no level/panel/position
options, `render()` holds one renderer slot, and the frame loop `process.exit`s when the only window
closes. Multi-window would mean patching the Rust crate (open windows on the existing `App`, route
`applyBatch`/events per window id, a reconciler root per window). That is a GPUIX project, not a
feature task.

**b. NSPopover hosting a WKWebView with local HTML: works.** `NSPopover` (`behavior = transient`)
gives, for free: the native rounded vibrant material with an arrow under the status item, dismissal
on outside click and Esc, correct Spaces/full-screen behaviour. With `drawsBackground = NO` the page
is transparent over the material. `WKScriptMessageHandler` (`makeObject`) delivered
`postMessage('loaded')` to JS on the main thread; JS → page is `evaluateJavaScript:` (or reload).
Opened via `performClick:` on the button and captured with `screencapture`.

Trade-off: we cannot reuse the GPUIX React components directly. Mitigation: the panel is small and
read-mostly; render it as static HTML from a pure TS function (`menuBarHtml(model, palette)`) that
pulls colours from `src/theme.ts` `palette()` and date formatting from `src/calendar/format.ts`, so
the look and the data logic stay shared and unit-testable. JavaScript is enabled but the page is our
own string, `baseURL:nil`, and navigation is cancelled (same delegate pattern as mail-webview.ts).

Rejected: native NSView content (lots of FFI layout code, nothing reusable); a custom borderless
NSPanel (we would re-implement dismissal/positioning that NSPopover already does).

## 3. Window close behaviour (ran)

Today: the GPUIX window is its own delegate (`GPUIWindow`); closing it makes `tick()` return false,
and `startFrameLoop`'s `onTerminated` in `@gpuix/react` calls `process.exit(0)`, so sync and
notifications die with the window. Nothing in `src/mail.tsx` intercepts it (the `render(...)` call at
the bottom is the only wiring).

Proven fix: `class_replaceMethod` on the window's class for `windowShouldClose:` → `orderOut:` +
return `NO`. The window hid, `tick()` kept running, the process stayed alive. `GPUIApplicationDelegate`
already implements `applicationShouldHandleReopen:hasVisibleWindows:`; replacing it with
`makeKeyAndOrderFront:` gives Dock-click reopen. The menu item's "Open Jefi" does the same plus
`activateIgnoringOtherApps:`. `setActivationPolicy:` switched 0 (regular) ↔ 1 (accessory, no Dock
icon) live without disturbing the window.

For production do the swizzle in a tiny `.m` helper (like notifications.m) or, better, as a gpuix
patch (`WindowOptions.hideOnClose`), because the prototype replaced the method on the KVO subclass
from JS. Quit stays Cmd+Q / the GPUI app menu / a "Quit Jefi" row in the panel (`[NSApp terminate:]`).
Recommendation: keep the Dock icon while the window is visible, switch to accessory when hidden
(opt-in setting "Hide Dock icon when window is closed"); the window must also set
`show`/activate after `setActivationPolicy: 0`.

## 4. Event reminders: do not exist

No `VALARM`/alarm/reminder in `src/engine/calendar/*` or `src/calendar/*` (types.ts `CalendarEvent`
has no alarm field; the only "Reminder" hit is an event title in a test). Scheduler belongs in the
**engine worker**: it owns the DB, keeps running while the window is hidden, and already runs timers
(snooze wake). It emits a `reminderDue { eventId, occurrenceStart, title, startAt }` event; the UI
side only turns it into a `showNotification` (extended to carry an event route) and a panel entry.
Needs: parse `VALARM` TRIGGER on import (`src/detect/ics.ts` / engine ics), a per-event
`alarms: number[]` (minutes before) plus a default in settings, and a "next due" computation over
`recurrence.ts` occurrences re-armed on `calendarChanged` and on wake (`src/engine/wake.ts`).

## 5. Data already available to the UI

| Need | Source | Status |
|---|---|---|
| Unread counts | `useMailSelector(s => s.inboxUnread)` (per account; `DockBadge` in mail.tsx already sums it) | ready |
| Recent new mail | `store.tsx` ~l.580: new-mail bursts (`new-mail.ts` `newMailCopy`) → `showNotification`; routes via `notify.ts` `dispatchNotificationOpen` / `notification-routing.ts` | fired, not retained: add a small ring buffer |
| Invites awaiting reply | `Attendee.partstat === 'needs-action'` on events (`engine/calendar/types.ts`), invites applied by `engine/calendar/invites.ts` | no query: add `engine.pendingInvites()` |
| Today / up next | `useEvents(from, to)` in `local-data.ts` (occurrences, recurrence-expanded), `useNow()` in `calendar/hooks.ts` | ready |
| Month grid | `calendar/mini-month.tsx` logic, `useWeekInfo()` | logic reusable, render as HTML |
| Quick add | `detectDates()` in `src/detect/dates.ts`; `openEventEditor(prefill)` in `calendar/state.ts` | ready |

## Recommended plan

1. **Keep running when closed** — new `src/native/app-lifecycle.ts` (+ `scripts/native/lifecycle.m`
   built in scripts/bundle.ts, JS fallback via objc swizzle for dev): `installHideOnClose()`,
   `showMainWindow()`, `setDockVisible(bool)`, `quit()`. Settings `menuBar: boolean` (default on) and
   `hideDockWhenClosed` in `src/theme.ts` Settings + settings UI. Wire in `mail.tsx` after `render`.
   Tests: pure decision fn (`closeAction(settings) → 'hide' | 'quit'`). Verify: automation script
   performs `performClose:`, asserts process alive and `isVisible=0`, then reopen.
2. **Status item + bridge** — `src/native/status-item.ts`: `createStatusItem({ onClick })`,
   `setStatusTitle(text)`, template image from `src/assets` mark. `MenuBarHost` component in
   mail.tsx (like `DockBadge`) computes the title (`menuBarTitle(unread, nextEvent, now)`, pure,
   unit-tested; short strings only). Verify: `screencapture -R` of the bar region.
3. **Panel** — `src/menubar/panel-html.ts` (pure `menuBarHtml(model, palette)`: up next + countdown,
   today, month grid, recent, quick actions, Quit) + `src/native/menubar-popover.ts` (NSPopover,
   WKWebView, message handler → `{ type: 'open-thread' | 'open-event' | 'compose' | 'new-event' |
   'new-note' | 'quick-add', … }`; pushes model updates via `evaluateJavaScript`). Actions call
   `showMainWindow()` then existing routes (`dispatchNotificationOpen`, `showEvent`,
   `openEventEditor`, compose). Snapshot tests on the HTML; screenshot via a `scripts/shot-menubar.ts`
   using `JEFI_CONFIG_DIR` + `scripts/testing/fixture.ts`, clicking with `performClick:`.
4. **Panel data** — `engine.pendingInvites()` (worker + worker-client + test with the IMAP test
   server fixture), a recent-notifications ring buffer in store.tsx (mail + invites + reminders,
   capped ~10, cleared when opened).
5. **Event reminders** — VALARM parse/store, `alarms` on events + default setting, worker scheduler
   emitting `reminderDue`, UI → `showNotification` with an event route (notifications.m userInfo gains
   `eventId`). Tests with a fake clock in `engine/calendar/*.test.ts`.

Order: 1 → 2 → 3; 4 and 5 are independent and feed 3.
