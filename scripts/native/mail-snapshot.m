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
