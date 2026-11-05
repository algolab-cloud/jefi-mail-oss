#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#include <math.h>
#include <stdint.h>

typedef void (*JefiMailSnapshotCallback)(
    uint32_t request_id,
    const uint8_t *png_bytes,
    size_t length);

static const double JefiMailSnapshotMaximumLogicalPixels = 4000000.0;
static const NSUInteger JefiMailSnapshotMaximumPNGBytes = 24 * 1024 * 1024;

// Snapshot state is main-queue confined. WebKit does not expose cancellation for an in-flight
// snapshot, so a concurrent request fails immediately rather than retaining an unbounded queue.
static BOOL jefi_mail_snapshot_in_flight = NO;
static uint64_t jefi_mail_snapshot_generation = 0;

static void jefi_mail_snapshot_fail(uint32_t request_id, JefiMailSnapshotCallback callback) {
  NSCAssert([NSThread isMainThread], @"Mail snapshot callbacks must run on the main thread");
  callback(request_id, NULL, 0);
}

static BOOL jefi_mail_snapshot_valid_bounds(NSRect bounds) {
  if (!isfinite(bounds.origin.x) || !isfinite(bounds.origin.y) ||
      !isfinite(bounds.size.width) || !isfinite(bounds.size.height)) {
    return NO;
  }
  if (bounds.size.width <= 0 || bounds.size.height <= 0) return NO;
  return bounds.size.width <= JefiMailSnapshotMaximumLogicalPixels / bounds.size.height;
}

static NSData *jefi_mail_snapshot_png(NSImage *image) {
  NSData *tiff = image.TIFFRepresentation;
  if (!tiff) return nil;
  NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:tiff];
  if (!bitmap) return nil;
  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (!png || png.length == 0 || png.length > JefiMailSnapshotMaximumPNGBytes) return nil;
  return png;
}

static void jefi_mail_snapshot_on_main(
    WKWebView *web_view,
    uint32_t request_id,
    JefiMailSnapshotCallback callback) {
  NSCAssert([NSThread isMainThread], @"WKWebView snapshots must start on the main thread");
  if (![web_view isKindOfClass:[WKWebView class]] || jefi_mail_snapshot_in_flight) {
    jefi_mail_snapshot_fail(request_id, callback);
    return;
  }

  NSRect bounds = web_view.bounds;
  if (!jefi_mail_snapshot_valid_bounds(bounds)) {
    jefi_mail_snapshot_fail(request_id, callback);
    return;
  }

  jefi_mail_snapshot_in_flight = YES;
  uint64_t generation = ++jefi_mail_snapshot_generation;
  if (generation == 0) generation = ++jefi_mail_snapshot_generation;

  WKSnapshotConfiguration *configuration = [[WKSnapshotConfiguration alloc] init];
  configuration.rect = bounds;

  // Capturing a strong reference in the completion path keeps the WKWebView alive even if the
  // JavaScript owner releases its pointer while WebKit is rendering the snapshot. Setting only
  // rect asks WebKit for the current viewport at native scale, preserving style and scroll.
  WKWebView *captured_web_view = web_view;
  [captured_web_view takeSnapshotWithConfiguration:configuration
                         completionHandler:^(NSImage *_Nullable image, NSError *_Nullable error) {
    void (^finish)(void) = ^{
      __attribute__((objc_precise_lifetime)) WKWebView *retained_web_view = captured_web_view;
      (void)retained_web_view;
      if (!jefi_mail_snapshot_in_flight || generation != jefi_mail_snapshot_generation) return;
      jefi_mail_snapshot_in_flight = NO;
      NSData *png = error == nil && image ? jefi_mail_snapshot_png(image) : nil;
      if (!png) {
        jefi_mail_snapshot_fail(request_id, callback);
        return;
      }
      // The byte pointer is borrowed and remains valid only for this synchronous callback.
      callback(request_id, png.bytes, png.length);
    };
    if ([NSThread isMainThread]) finish();
    else dispatch_async(dispatch_get_main_queue(), finish);
  }];
}

__attribute__((visibility("default"))) void jefi_mail_snapshot(
    void *web_view,
    uint32_t request_id,
    JefiMailSnapshotCallback callback) {
  if (!callback) return;
  if (!web_view) {
    if ([NSThread isMainThread]) jefi_mail_snapshot_fail(request_id, callback);
    else dispatch_async(dispatch_get_main_queue(), ^{ jefi_mail_snapshot_fail(request_id, callback); });
    return;
  }

  // Assigning the bridged object to a strong local makes the queued block retain it before this
  // function returns, then WebKit retains it again through the asynchronous completion.
  WKWebView *view = (__bridge WKWebView *)web_view;
  void (^capture)(void) = ^{ jefi_mail_snapshot_on_main(view, request_id, callback); };
  if ([NSThread isMainThread]) capture();
  else dispatch_async(dispatch_get_main_queue(), capture);
}

// ---------------------------------------------------------------------------
// Content height: how tall the message is at the view's current width, so the reader can size the
// view to fit it instead of scrolling it inside a fixed box. Page JavaScript stays off: this one
// script is the app's, run in WebKit's client world, where the page's own code can't reach it.
// ---------------------------------------------------------------------------

typedef void (*JefiMailHeightCallback)(uint32_t request_id, double height);

// Overflowing: the document's scroll height is the content's, and the page keeps its own scrolling
// until the view is resized to fit. Fitting: the scroll height is at least the viewport, so measure
// what the body holds (text included) to let the view shrink, and stop the page scrolling (and
// bouncing) vertically, so the wheel scrolls the conversation around it instead.
static NSString *const JefiMailHeightScript =
    @"(() => {"
     "const d = document.documentElement, b = document.body;"
     "if (!d || !b) return 0;"
     "if (d.scrollHeight > innerHeight + 1) { d.style.removeProperty('overflow-y'); return d.scrollHeight; }"
     "d.style.setProperty('overflow-y', 'hidden', 'important');"
     "const range = document.createRange(); range.selectNodeContents(b);"
     "const style = getComputedStyle(b);"
     "const bottom = range.getBoundingClientRect().bottom + scrollY;"
     "return Math.ceil(bottom + parseFloat(style.paddingBottom || '0') + parseFloat(style.marginBottom || '0'));"
     "})()";

static void jefi_mail_content_height_on_main(
    WKWebView *web_view,
    uint32_t request_id,
    JefiMailHeightCallback callback) {
  NSCAssert([NSThread isMainThread], @"WKWebView scripts must start on the main thread");
  if (![web_view isKindOfClass:[WKWebView class]]) {
    callback(request_id, -1);
    return;
  }
  WKWebView *captured_web_view = web_view;
  [captured_web_view evaluateJavaScript:JefiMailHeightScript
                                inFrame:nil
                         inContentWorld:WKContentWorld.defaultClientWorld
                      completionHandler:^(id _Nullable result, NSError *_Nullable error) {
    void (^finish)(void) = ^{
      __attribute__((objc_precise_lifetime)) WKWebView *retained_web_view = captured_web_view;
      (void)retained_web_view;
      double height = error == nil && [result isKindOfClass:[NSNumber class]] ? [(NSNumber *)result doubleValue] : -1;
      callback(request_id, isfinite(height) ? height : -1);
    };
    if ([NSThread isMainThread]) finish();
    else dispatch_async(dispatch_get_main_queue(), finish);
  }];
}

__attribute__((visibility("default"))) void jefi_mail_content_height(
    void *web_view,
    uint32_t request_id,
    JefiMailHeightCallback callback) {
  if (!callback) return;
  if (!web_view) {
    if ([NSThread isMainThread]) callback(request_id, -1);
    else dispatch_async(dispatch_get_main_queue(), ^{ callback(request_id, -1); });
    return;
  }
  WKWebView *view = (__bridge WKWebView *)web_view;
  void (^measure)(void) = ^{ jefi_mail_content_height_on_main(view, request_id, callback); };
  if ([NSThread isMainThread]) measure();
  else dispatch_async(dispatch_get_main_queue(), measure);
}

// ---------------------------------------------------------------------------
// Scrolling. The app's web view is this subclass, sitting in a clipping view on the window's own
// view (GPUIX). The page is at most as tall as the reader, so it can always be seen whole; WebKit
// keeps the wheel over it even when the page has nothing to scroll, so each gesture is routed here
// as it starts: to the reader (GPUIX's view under the pointer, which scrolls the conversation) or
// to the page. Vertical gestures go to the reader when
//   - the whole message fits (the page has nothing to scroll),
//   - the page is cut off by the reader's edge (bring it whole into view first), or
//   - the page is already at its top or bottom in that direction (carry on into the conversation).
// Horizontal gestures always stay with the page (wide newsletters).
// ---------------------------------------------------------------------------

static NSString *const JefiMailEdgesScript =
    @"[scrollY <= 1, scrollY + innerHeight >= document.documentElement.scrollHeight - 1]";

@interface JefiMailWebView : WKWebView
/** The whole message fits in the page: nothing to scroll inside. */
@property(nonatomic) BOOL jefiFits;
@property(nonatomic) BOOL jefiAtTop;
@property(nonatomic) BOOL jefiAtBottom;
@end

@implementation JefiMailWebView {
  /** Decided as each gesture starts, so one gesture never splits between the page and the reader. */
  BOOL _gestureToReader;
}

/** Part of the page is outside the reader's visible area (the clipping view is the visible part). */
- (BOOL)jefiCutOff {
  NSView *clip = self.superview;
  return clip && clip.bounds.size.height < self.frame.size.height - 1;
}

- (void)jefiReadEdges {
  __weak JefiMailWebView *weakSelf = self;
  [self evaluateJavaScript:JefiMailEdgesScript inFrame:nil inContentWorld:WKContentWorld.defaultClientWorld
         completionHandler:^(id _Nullable result, NSError *_Nullable error) {
    JefiMailWebView *strongSelf = weakSelf;
    if (!strongSelf || error || ![result isKindOfClass:[NSArray class]] || [(NSArray *)result count] != 2) return;
    strongSelf.jefiAtTop = [[(NSArray *)result objectAtIndex:0] boolValue];
    strongSelf.jefiAtBottom = [[(NSArray *)result objectAtIndex:1] boolValue];
  }];
}

/**
 * The view under the pointer if this page weren't there: GPUIX's own view, a sibling of the clipping
 * view in the window's content view (or the content view itself), which scrolls the reader there.
 */
- (NSView *)jefiReaderViewFor:(NSEvent *)event {
  NSView *clip = self.superview;
  NSView *host = clip.superview;
  if (!host) return nil;
  NSPoint point = [host convertPoint:event.locationInWindow fromView:nil];
  for (NSView *view in host.subviews.reverseObjectEnumerator) {
    if (view == clip || view.isHidden) continue;
    NSView *hit = [view hitTest:point];
    if (hit) return hit;
  }
  return host;
}

- (void)scrollWheel:(NSEvent *)event {
  BOOL wheel = event.phase == NSEventPhaseNone && event.momentumPhase == NSEventPhaseNone;
  BOOL starts = wheel || event.phase == NSEventPhaseBegan || event.phase == NSEventPhaseMayBegin;
  if (starts) {
    CGFloat dx = event.scrollingDeltaX, dy = event.scrollingDeltaY;
    BOOL vertical = fabs(dx) <= fabs(dy);
    // Positive deltaY shows what's above (the page's top), negative what's below.
    BOOL pastEdge = (dy > 0 && self.jefiAtTop) || (dy < 0 && self.jefiAtBottom);
    _gestureToReader = vertical && (self.jefiFits || [self jefiCutOff] || pastEdge);
  }
  NSView *reader = _gestureToReader ? [self jefiReaderViewFor:event] : nil;
  if (reader) {
    [reader scrollWheel:event];
    return;
  }
  [super scrollWheel:event];
  // Once the page has scrolled, learn where it stopped, so the next gesture knows whether to carry on.
  BOOL ends = wheel || event.momentumPhase == NSEventPhaseEnded ||
      ((event.phase == NSEventPhaseEnded || event.phase == NSEventPhaseCancelled) && event.momentumPhase == NSEventPhaseNone);
  if (ends) [self jefiReadEdges];
}
@end

/**
 * Tells the app's web view whether its whole message fits. `reset` marks a newly loaded message,
 * which starts scrolled to its top.
 */
__attribute__((visibility("default"))) void jefi_mail_forward_scroll(void *web_view, bool fits, bool reset) {
  if (!web_view) return;
  id view = (__bridge id)web_view;
  void (^apply)(void) = ^{
    if (![view isKindOfClass:[JefiMailWebView class]]) return;
    JefiMailWebView *web = view;
    web.jefiFits = fits;
    if (reset) {
      web.jefiAtTop = YES;
      web.jefiAtBottom = NO;
    }
  };
  if ([NSThread isMainThread]) apply();
  else dispatch_async(dispatch_get_main_queue(), apply);
}
