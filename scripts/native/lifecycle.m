#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <stdbool.h>

// Keeps Jefi running when its window is closed. GPUIX exits the process once its last window closes,
// so the close button hides the window instead (windowShouldClose: answers NO), and a Dock click or
// relaunch shows it again. Everything here runs on the main thread: Bun calls in from the frame loop
// that pumps AppKit, and AppKit calls the replaced methods from that same run loop.

static NSWindow *mainWindow = nil;
static BOOL hideOnClose = NO;
static BOOL hideDock = NO;
static IMP originalShouldClose = NULL;
static IMP originalReopen = NULL;

static void applyDockPolicy(void) {
  BOOL hidden = mainWindow && !mainWindow.isVisible;
  NSApplicationActivationPolicy policy = hidden && hideOnClose && hideDock ? NSApplicationActivationPolicyAccessory : NSApplicationActivationPolicyRegular;
  if (NSApp.activationPolicy != policy) [NSApp setActivationPolicy:policy];
}

static void showMain(void) {
  if (!mainWindow) return;
  // The Dock icon comes back first: an accessory app's window can't become key reliably.
  if (NSApp.activationPolicy != NSApplicationActivationPolicyRegular) [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  if (mainWindow.isMiniaturized) [mainWindow deminiaturize:nil];
  [mainWindow makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

static BOOL jefiWindowShouldClose(id self, SEL cmd, NSWindow *sender) {
  if (sender == mainWindow && hideOnClose) {
    [sender orderOut:nil];
    applyDockPolicy();
    return NO;
  }
  if (originalShouldClose) return ((BOOL (*)(id, SEL, NSWindow *))originalShouldClose)(self, cmd, sender);
  return YES;
}

static BOOL jefiShouldHandleReopen(id self, SEL cmd, NSApplication *app, BOOL visible) {
  if (mainWindow && !mainWindow.isVisible) {
    showMain();
    return YES;
  }
  if (originalReopen) return ((BOOL (*)(id, SEL, NSApplication *, BOOL))originalReopen)(self, cmd, app, visible);
  return YES;
}

/** Replaces `selector` on `klass`, keeping whatever it (or a superclass) did before. */
static IMP replace(Class klass, SEL selector, IMP implementation, const char *types) {
  Method existing = class_getInstanceMethod(klass, selector);
  IMP previous = existing ? method_getImplementation(existing) : NULL;
  class_replaceMethod(klass, selector, implementation, types);
  return previous == implementation ? NULL : previous;
}

static NSWindow *findMainWindow(void) {
  for (NSWindow *window in NSApp.windows) {
    if ([NSStringFromClass([window class]) containsString:@"GPUI"]) return window;
  }
  return NSApp.mainWindow ?: NSApp.windows.firstObject;
}

/** Finds GPUIX's window and installs the hooks once. False while the window doesn't exist yet. */
bool jefi_lifecycle_install(void) {
  if (mainWindow) return true;
  NSWindow *window = findMainWindow();
  id delegate = window.delegate;
  if (!window || !delegate) return false;
  mainWindow = window;
  // [delegate class] is the real class under a KVO subclass, so the method is shared by both.
  originalShouldClose = replace([delegate class], @selector(windowShouldClose:), (IMP)jefiWindowShouldClose, "c@:@");
  id appDelegate = NSApp.delegate;
  if (appDelegate) {
    originalReopen = replace([appDelegate class], @selector(applicationShouldHandleReopen:hasVisibleWindows:), (IMP)jefiShouldHandleReopen, "c@:@c");
  }
  return true;
}

void jefi_lifecycle_configure(bool hide, bool dock) {
  hideOnClose = hide;
  hideDock = dock;
  // Turning "keep running" off while the window is hidden would strand an invisible app.
  if (mainWindow && !mainWindow.isVisible && !hideOnClose) showMain();
  else applyDockPolicy();
}

void jefi_lifecycle_show(void) {
  showMain();
}

bool jefi_lifecycle_window_visible(void) {
  return mainWindow && mainWindow.isVisible;
}

void jefi_lifecycle_close(void) {
  [mainWindow performClose:nil];
}

void jefi_lifecycle_quit(void) {
  [NSApp terminate:nil];
}

// --- jefi:// links -------------------------------------------------------------------------------
// LaunchServices delivers a link as a kAEGetURL Apple Event. A cold launch sends it once, as soon as
// the app's run loop turns, so the handler goes in before GPUIX makes its window and URLs wait here
// until JS asks for them. NSApplication installs its own handlers while it finishes launching, so
// ours goes back in on willFinishLaunching too. Apple Events arrive on the main thread.

typedef void (*JefiLinkCallback)(const char *url);

@interface JefiLinkHandler : NSObject
@end

static JefiLinkHandler *linkHandler = nil;
static JefiLinkCallback linkCallback = NULL;
static NSMutableArray<NSString *> *pendingLinks = nil;

static void deliverLink(NSString *url) {
  if (linkCallback) linkCallback(url.UTF8String);
  else [pendingLinks addObject:url];
}

@implementation JefiLinkHandler
- (void)handleGetURL:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
  (void)reply;
  NSString *url = [event paramDescriptorForKeyword:keyDirectObject].stringValue;
  // Only our scheme, and never an unbounded string from another app.
  if (url.length && url.length <= 8192 && [url.lowercaseString hasPrefix:@"jefi:"]) deliverLink(url);
}

- (void)install {
  [[NSAppleEventManager sharedAppleEventManager] setEventHandler:self andSelector:@selector(handleGetURL:withReplyEvent:) forEventClass:kInternetEventClass andEventID:kAEGetURL];
}

- (void)willFinishLaunching:(NSNotification *)note {
  (void)note;
  [self install];
}
@end

/** Installs the link handler. Idempotent; call it before the window exists. */
void jefi_links_install(void) {
  if (linkHandler) return;
  linkHandler = [JefiLinkHandler new];
  pendingLinks = [NSMutableArray array];
  [linkHandler install];
  [[NSNotificationCenter defaultCenter] addObserver:linkHandler selector:@selector(willFinishLaunching:) name:NSApplicationWillFinishLaunchingNotification object:nil];
}

/** Sets where links go (on the main thread) and hands over any that arrived before. */
void jefi_links_listen(JefiLinkCallback callback) {
  jefi_links_install();
  linkCallback = callback;
  if (!callback) return;
  NSArray<NSString *> *queued = [pendingLinks copy];
  [pendingLinks removeAllObjects];
  for (NSString *url in queued) callback(url.UTF8String);
}
