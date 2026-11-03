#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Intents/Intents.h>
#import <Security/Security.h>
#import <UserNotifications/UserNotifications.h>
#include <stdbool.h>

typedef void (*JefiNotificationOpenCallback)(const char *account_id, const char *thread_id);
// An event reminder's route: the event id and the occurrence's start (epoch ms, as text).
typedef void (*JefiEventOpenCallback)(const char *event_id, const char *occurrence_start);

// A banner with a sign-in code: its category, and the button's action.
static NSString *const JefiSignInCodeCategory = @"jefi-sign-in-code";
static NSString *const JefiCopyCodeAction = @"copy";

@interface JefiNotificationPayload : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *title;
@property(nonatomic, copy) NSString *subtitle;
@property(nonatomic, copy) NSString *body;
@property(nonatomic, copy) NSString *accountId;
@property(nonatomic, copy) NSString *threadId;
// Set instead of accountId/threadId for an event reminder.
@property(nonatomic, copy) NSString *eventId;
@property(nonatomic, copy) NSString *occurrenceStart;
// What the banner shows beside its text (see jefiNotificationImage): empty for none.
@property(nonatomic, copy) NSString *image;
// A sign-in code the banner offers to copy (its "Copy code" button): empty for none.
@property(nonatomic, copy) NSString *codeToCopy;
@end

@implementation JefiNotificationPayload
@end

// ---------------------------------------------------------------------------
// The picture beside a banner's text: the sender's photo or initials for mail, a symbol for a task
// or event reminder. The spec is tab-separated text from JS, one of
//   photo<TAB>/path/to/image      initials<TAB>AB<TAB>#RRGGBB      symbol<TAB>sf.name<TAB>#RRGGBB
// drawn here into a PNG. A release build signed with the Communication Notifications entitlement
// sends the banner as a message from a person with this picture, which macOS shows in place of the
// app icon (see jefiCommunicationContent). Anywhere else (dev and ad hoc builds) the banner shows the
// app icon alone: the picture as an attachment beside it read as two icons on one banner.
// ---------------------------------------------------------------------------

static NSColor *jefiColor(NSString *hex) {
  unsigned int rgb = 0x8B5CF6;
  if (hex.length == 7 && [hex hasPrefix:@"#"]) [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&rgb];
  return [NSColor colorWithSRGBRed:((rgb >> 16) & 0xFF) / 255.0 green:((rgb >> 8) & 0xFF) / 255.0 blue:(rgb & 0xFF) / 255.0 alpha:1];
}

static NSData *jefiNotificationImageData(NSString *spec) {
  NSArray<NSString *> *parts = [spec componentsSeparatedByString:@"\t"];
  if (parts.count < 2) return nil;
  NSString *kind = parts[0];
  const CGFloat side = 256;
  NSRect bounds = NSMakeRect(0, 0, side, side);
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:(NSInteger)side pixelsHigh:(NSInteger)side bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
  NSGraphicsContext *context = rep ? [NSGraphicsContext graphicsContextWithBitmapImageRep:rep] : nil;
  if (!context) return nil;
  BOOL drawn = NO;
  [NSGraphicsContext saveGraphicsState];
  [NSGraphicsContext setCurrentContext:context];
  if ([kind isEqualToString:@"photo"]) {
    NSImage *photo = [[NSImage alloc] initWithContentsOfFile:parts[1]];
    NSSize size = photo.size;
    if (photo && size.width > 0 && size.height > 0) {
      [[NSBezierPath bezierPathWithOvalInRect:bounds] addClip];
      // Filled, not fitted: the face covers the circle and the overflow is clipped.
      CGFloat scale = MAX(side / size.width, side / size.height);
      NSRect frame = NSMakeRect((side - size.width * scale) / 2, (side - size.height * scale) / 2, size.width * scale, size.height * scale);
      [photo drawInRect:frame fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
      drawn = YES;
    }
  } else if ([kind isEqualToString:@"initials"] && parts.count >= 3 && parts[1].length) {
    [jefiColor(parts[2]) setFill];
    [[NSBezierPath bezierPathWithOvalInRect:bounds] fill];
    NSFont *font = [NSFont systemFontOfSize:side * 0.4 weight:NSFontWeightSemibold];
    NSDictionary *attributes = @{ NSFontAttributeName: font, NSForegroundColorAttributeName: NSColor.whiteColor };
    NSSize text = [parts[1] sizeWithAttributes:attributes];
    // Centred on the capitals, not the line box, so the letters sit in the middle of the circle.
    CGFloat baseline = (side - font.capHeight) / 2;
    [parts[1] drawAtPoint:NSMakePoint((side - text.width) / 2, baseline + font.descender) withAttributes:attributes];
    drawn = YES;
  } else if ([kind isEqualToString:@"symbol"] && parts.count >= 3) {
    NSImageSymbolConfiguration *config = [[NSImageSymbolConfiguration configurationWithPointSize:side * 0.46 weight:NSFontWeightMedium]
        configurationByApplyingConfiguration:[NSImageSymbolConfiguration configurationWithPaletteColors:@[ NSColor.whiteColor ]]];
    NSImage *symbol = [[NSImage imageWithSystemSymbolName:parts[1] accessibilityDescription:nil] imageWithSymbolConfiguration:config];
    if (symbol) {
      [jefiColor(parts[2]) setFill];
      [[NSBezierPath bezierPathWithRoundedRect:bounds xRadius:side * 0.225 yRadius:side * 0.225] fill];
      NSSize size = symbol.size;
      [symbol drawInRect:NSMakeRect((side - size.width) / 2, (side - size.height) / 2, size.width, size.height) fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
      drawn = YES;
    }
  }
  [NSGraphicsContext restoreGraphicsState];
  if (!drawn) return nil;
  return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

#ifdef JEFI_NOTIFICATION_TESTING
// The picture as a file, so the smoke test can look at it.
static NSURL *jefiNotificationImageFile(NSData *png) {
  if (!png) return nil;
  NSString *name = [NSString stringWithFormat:@"jefi-notification-%@.png", [NSUUID UUID].UUIDString];
  NSURL *url = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:name]];
  return [png writeToURL:url atomically:YES] ? url : nil;
}

static NSURL *jefiNotificationImage(NSString *spec) {
  return jefiNotificationImageFile(jefiNotificationImageData(spec));
}
#endif

// ---------------------------------------------------------------------------
// Communication notifications: the banner arrives as an incoming message (INSendMessageIntent) from
// a person whose image is the picture above, and macOS draws that picture where the app icon would
// be, with the icon as a small badge. Only an app signed with
// com.apple.developer.usernotifications.communication (granted by its provisioning profile) gets
// this, so the process asks its own signature first; without it the update is never attempted.
// ---------------------------------------------------------------------------

static BOOL jefiCommunicationEntitled(void) {
  static BOOL entitled = NO;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
    if (!task) return;
    CFTypeRef value = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.developer.usernotifications.communication"), NULL);
    entitled = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value);
    if (value) CFRelease(value);
    CFRelease(task);
  });
  return entitled;
}

// `content` updated to come from a person called `name` with `picture`, or nil when macOS won't.
// `key` names the conversation (a mail thread, or one reminder occurrence) and keys the sender too.
static UNNotificationContent *jefiCommunicationContent(UNMutableNotificationContent *content, NSString *name, NSString *key, NSData *picture) {
  if (!picture || !name.length || !key.length || !jefiCommunicationEntitled()) return nil;
  INPersonHandle *handle = [[INPersonHandle alloc] initWithValue:key type:INPersonHandleTypeUnknown];
  INPerson *sender = [[INPerson alloc] initWithPersonHandle:handle nameComponents:nil displayName:name image:[INImage imageWithImageData:picture] contactIdentifier:nil customIdentifier:key];
  INSendMessageIntent *intent = [[INSendMessageIntent alloc] initWithRecipients:nil
                                                            outgoingMessageType:INOutgoingMessageTypeOutgoingMessageText
                                                                        content:content.body
                                                             speakableGroupName:nil
                                                         conversationIdentifier:key
                                                                    serviceName:nil
                                                                         sender:sender
                                                                    attachments:nil];
  [intent setImage:sender.image forParameterNamed:@"sender"];
  INInteraction *interaction = [[INInteraction alloc] initWithIntent:intent response:nil];
  interaction.direction = INInteractionDirectionIncoming;
  [interaction donateInteractionWithCompletion:nil];
  NSError *error = nil;
  UNNotificationContent *updated = [content contentByUpdatingWithProvider:intent error:&error];
  return error ? nil : updated;
}

typedef NS_ENUM(NSInteger, JefiAuthorizationState) {
  JefiAuthorizationUnknown,
  JefiAuthorizationRequesting,
  JefiAuthorizationGranted,
  JefiAuthorizationDenied,
};

@interface JefiNotificationBridge : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, assign) JefiNotificationOpenCallback openCallback;
@property(nonatomic, assign) JefiEventOpenCallback eventCallback;
@property(nonatomic, assign) JefiAuthorizationState authorizationState;
@property(nonatomic, strong) NSMutableArray<JefiNotificationPayload *> *pending;
@end

@implementation JefiNotificationBridge

- (instancetype)init {
  self = [super init];
  if (self) {
    _authorizationState = JefiAuthorizationUnknown;
    _pending = [NSMutableArray array];
  }
  return self;
}

- (void)schedule:(JefiNotificationPayload *)payload {
  UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
  content.title = payload.title;
  content.subtitle = payload.subtitle;
  content.body = payload.body;
  if (payload.eventId.length) {
    content.threadIdentifier = @"jefi-reminders";
    content.userInfo = @{ @"eventId": payload.eventId, @"occurrenceStart": payload.occurrenceStart ?: @"" };
  } else {
    content.threadIdentifier = payload.threadId;
    content.userInfo = payload.codeToCopy.length
        ? @{ @"accountId": payload.accountId, @"threadId": payload.threadId, @"copy": payload.codeToCopy }
        : @{ @"accountId": payload.accountId, @"threadId": payload.threadId };
    if (payload.codeToCopy.length) content.categoryIdentifier = JefiSignInCodeCategory;
  }
  NSData *picture = payload.image.length ? jefiNotificationImageData(payload.image) : nil;
  // From a person, with the picture in place of the app icon. Each reminder is its own conversation:
  // they share a thread, but not a face. A build that may not send communication notifications shows
  // the app icon alone: the picture as an attachment beside it read as two icons on one banner.
  NSString *conversation = payload.eventId.length ? payload.identifier : payload.threadId;
  UNNotificationContent *message = jefiCommunicationContent(content, payload.title, conversation, picture);
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:payload.identifier content:message ?: content trigger:nil];
  [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request withCompletionHandler:nil];
}

- (void)enqueue:(JefiNotificationPayload *)payload {
  NSAssert([NSThread isMainThread], @"Jefi notification state is main-thread confined");
  if (self.authorizationState == JefiAuthorizationGranted) {
    [self schedule:payload];
    return;
  }
  if (self.authorizationState == JefiAuthorizationDenied) return;
  [self.pending addObject:payload];
  if (self.authorizationState == JefiAuthorizationRequesting) return;
  self.authorizationState = JefiAuthorizationRequesting;
  __weak JefiNotificationBridge *weakSelf = self;
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                completionHandler:^(BOOL granted, NSError *_Nullable error) {
    // Apple's completion queue is unspecified. Copy no native pointers into JS; return to the app's
    // main queue before touching state or scheduling any request.
    dispatch_async(dispatch_get_main_queue(), ^{
      JefiNotificationBridge *strongSelf = weakSelf;
      if (!strongSelf) return;
      strongSelf.authorizationState = granted && error == nil ? JefiAuthorizationGranted : JefiAuthorizationDenied;
      NSArray<JefiNotificationPayload *> *queued = [strongSelf.pending copy];
      [strongSelf.pending removeAllObjects];
      if (strongSelf.authorizationState == JefiAuthorizationGranted) {
        for (JefiNotificationPayload *item in queued) [strongSelf schedule:item];
      }
    });
  }];
}

- (void)openAccountId:(NSString *)accountId
             threadId:(NSString *)threadId
            completion:(void (^)(void))completion {
  if (!accountId.length || !threadId.length) {
    completion();
    return;
  }
  // ARC retains the strings and completion block until the main-queue work finishes. The callback
  // gets borrowed UTF-8 pointers only for its synchronous duration.
  void (^open)(void) = ^{
    [[NSApplication sharedApplication] activateIgnoringOtherApps:YES];
    if (self.openCallback) self.openCallback(accountId.UTF8String, threadId.UTF8String);
    completion();
  };
  if ([NSThread isMainThread]) open();
  else dispatch_async(dispatch_get_main_queue(), open);
}

- (void)openEventId:(NSString *)eventId
    occurrenceStart:(NSString *)occurrenceStart
         completion:(void (^)(void))completion {
  if (!eventId.length) {
    completion();
    return;
  }
  NSString *start = occurrenceStart ?: @"";
  void (^open)(void) = ^{
    [[NSApplication sharedApplication] activateIgnoringOtherApps:YES];
    if (self.eventCallback) self.eventCallback(eventId.UTF8String, start.UTF8String);
    completion();
  };
  if ([NSThread isMainThread]) open();
  else dispatch_async(dispatch_get_main_queue(), open);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
          withCompletionHandler:(void (^)(void))completionHandler {
  NSDictionary *userInfo = response.notification.request.content.userInfo;
  // "Copy code": the code goes to the clipboard and Jefi stays where it is, behind the app in use.
  if ([response.actionIdentifier isEqualToString:JefiCopyCodeAction]) {
    id text = userInfo[@"copy"];
    NSString *code = [text isKindOfClass:[NSString class]] ? [text copy] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (code.length) {
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        [pasteboard clearContents];
        [pasteboard setString:code forType:NSPasteboardTypeString];
      }
      completionHandler();
    });
    return;
  }
  id eventValue = userInfo[@"eventId"];
  if ([eventValue isKindOfClass:[NSString class]]) {
    id startValue = userInfo[@"occurrenceStart"];
    NSString *start = [startValue isKindOfClass:[NSString class]] ? [startValue copy] : nil;
    [self openEventId:[eventValue copy] occurrenceStart:start completion:completionHandler];
    return;
  }
  id accountValue = userInfo[@"accountId"];
  id threadValue = userInfo[@"threadId"];
  NSString *accountId = [accountValue isKindOfClass:[NSString class]] ? [accountValue copy] : nil;
  NSString *threadId = [threadValue isKindOfClass:[NSString class]] ? [threadValue copy] : nil;
  [self openAccountId:accountId threadId:threadId completion:completionHandler];
}

@end

static JefiNotificationBridge *bridge;

__attribute__((visibility("default"))) void jefi_notifications_start(JefiNotificationOpenCallback callback) {
  void (^install)(void) = ^{
    if (!bridge) bridge = [[JefiNotificationBridge alloc] init];
    bridge.openCallback = callback;
#ifndef JEFI_NOTIFICATION_TESTING
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = bridge;
    // The button a banner carrying a sign-in code shows. It runs in the background: no window opens.
    UNNotificationAction *copy = [UNNotificationAction actionWithIdentifier:JefiCopyCodeAction title:@"Copy code" options:UNNotificationActionOptionNone];
    [center setNotificationCategories:[NSSet setWithObject:[UNNotificationCategory categoryWithIdentifier:JefiSignInCodeCategory actions:@[ copy ] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone]]];
#endif
  };
  if ([NSThread isMainThread]) install();
  else dispatch_async(dispatch_get_main_queue(), install);
}

__attribute__((visibility("default"))) bool jefi_notifications_show(
    const char *identifier,
    const char *title,
    const char *subtitle,
    const char *body,
    const char *account_id,
    const char *thread_id,
    const char *image,
    const char *copy_text) {
  if (!identifier || !title || !body || !account_id || !thread_id) return false;
  JefiNotificationPayload *payload = [[JefiNotificationPayload alloc] init];
  payload.identifier = [NSString stringWithUTF8String:identifier];
  payload.title = [NSString stringWithUTF8String:title];
  payload.subtitle = subtitle ? [NSString stringWithUTF8String:subtitle] : @"";
  payload.body = [NSString stringWithUTF8String:body];
  payload.accountId = [NSString stringWithUTF8String:account_id];
  payload.threadId = [NSString stringWithUTF8String:thread_id];
  payload.image = image ? ([NSString stringWithUTF8String:image] ?: @"") : @"";
  payload.codeToCopy = copy_text ? ([NSString stringWithUTF8String:copy_text] ?: @"") : @"";
  if (!payload.identifier || !payload.title || !payload.body || !payload.accountId || !payload.threadId) return false;
  void (^enqueue)(void) = ^{
    if (!bridge) bridge = [[JefiNotificationBridge alloc] init];
    [bridge enqueue:payload];
  };
  if ([NSThread isMainThread]) enqueue();
  else dispatch_async(dispatch_get_main_queue(), enqueue);
  return true;
}

__attribute__((visibility("default"))) void jefi_notifications_set_event_callback(JefiEventOpenCallback callback) {
  void (^install)(void) = ^{
    if (!bridge) bridge = [[JefiNotificationBridge alloc] init];
    bridge.eventCallback = callback;
  };
  if ([NSThread isMainThread]) install();
  else dispatch_async(dispatch_get_main_queue(), install);
}

// An event reminder: same queueing and authorization as mail, routed by event instead of thread.
__attribute__((visibility("default"))) bool jefi_notifications_show_event(
    const char *identifier,
    const char *title,
    const char *subtitle,
    const char *body,
    const char *event_id,
    const char *occurrence_start,
    const char *image) {
  if (!identifier || !title || !body || !event_id || !occurrence_start) return false;
  JefiNotificationPayload *payload = [[JefiNotificationPayload alloc] init];
  payload.identifier = [NSString stringWithUTF8String:identifier];
  payload.title = [NSString stringWithUTF8String:title];
  payload.subtitle = subtitle ? [NSString stringWithUTF8String:subtitle] : @"";
  payload.body = [NSString stringWithUTF8String:body];
  payload.eventId = [NSString stringWithUTF8String:event_id];
  payload.occurrenceStart = [NSString stringWithUTF8String:occurrence_start];
  payload.image = image ? ([NSString stringWithUTF8String:image] ?: @"") : @"";
  if (!payload.identifier || !payload.title || !payload.body || !payload.eventId.length || !payload.occurrenceStart) return false;
  void (^enqueue)(void) = ^{
    if (!bridge) bridge = [[JefiNotificationBridge alloc] init];
    [bridge enqueue:payload];
  };
  if ([NSThread isMainThread]) enqueue();
  else dispatch_async(dispatch_get_main_queue(), enqueue);
  return true;
}

// ---------------------------------------------------------------------------
// Permission: the onboarding screen and Settings ask for the current status, and request it
// deliberately instead of on the first banner. Results travel as small integers with the caller's
// token, always on the main queue; no Objective-C object crosses into JS.
// ---------------------------------------------------------------------------

typedef void (*JefiAuthorizationCallback)(int32_t token, int32_t status);

enum {
  JefiStatusError = -1,
  JefiStatusNotDetermined = 0,
  JefiStatusDenied = 1,
  JefiStatusAuthorized = 2,
  JefiStatusProvisional = 3,
  JefiStatusEphemeral = 4,
};

static int32_t jefiStatusCode(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined: return JefiStatusNotDetermined;
    case UNAuthorizationStatusDenied: return JefiStatusDenied;
    case UNAuthorizationStatusAuthorized: return JefiStatusAuthorized;
    case UNAuthorizationStatusProvisional: return JefiStatusProvisional;
    default: return JefiStatusEphemeral;
  }
}

// UNUserNotificationCenter raises for a process without a bundle identifier (an unbundled Bun), which
// would abort the app; report "unavailable" instead of touching it.
static bool jefiCenterAvailable(void) {
  return [[NSBundle mainBundle] bundleIdentifier].length > 0;
}

// The lazy path remembers a refusal for the life of the process; a later grant in System Settings
// or through the onboarding screen must let queued and future banners through.
static void jefiRecordStatus(int32_t code) {
  if (!bridge) bridge = [[JefiNotificationBridge alloc] init];
  if (code >= JefiStatusAuthorized) {
    if (bridge.authorizationState == JefiAuthorizationRequesting) return;
    bridge.authorizationState = JefiAuthorizationGranted;
    NSArray<JefiNotificationPayload *> *queued = [bridge.pending copy];
    [bridge.pending removeAllObjects];
    for (JefiNotificationPayload *item in queued) [bridge schedule:item];
  } else if (code == JefiStatusNotDetermined && bridge.authorizationState == JefiAuthorizationDenied) {
    bridge.authorizationState = JefiAuthorizationUnknown;
  }
}

__attribute__((visibility("default"))) bool jefi_notifications_authorization_status(JefiAuthorizationCallback callback, int32_t token) {
  if (!callback || !jefiCenterAvailable()) return false;
  [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    int32_t code = jefiStatusCode(settings.authorizationStatus);
    dispatch_async(dispatch_get_main_queue(), ^{
      jefiRecordStatus(code);
      callback(token, code);
    });
  }];
  return true;
}

// Alert only, like the lazy path: banners carry no sound, and the unread badge is drawn on the Dock
// tile directly, which needs no permission.
__attribute__((visibility("default"))) bool jefi_notifications_request_authorization(JefiAuthorizationCallback callback, int32_t token) {
  if (!callback || !jefiCenterAvailable()) return false;
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:UNAuthorizationOptionAlert
                    completionHandler:^(BOOL granted, NSError *_Nullable error) {
    int32_t code = error != nil ? JefiStatusError : granted ? JefiStatusAuthorized : JefiStatusDenied;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (code == JefiStatusAuthorized) jefiRecordStatus(code);
      else if (code == JefiStatusDenied && bridge && bridge.authorizationState != JefiAuthorizationRequesting) bridge.authorizationState = JefiAuthorizationDenied;
      callback(token, code);
    });
  }];
  return true;
}

#ifdef JEFI_NOTIFICATION_TESTING
// Draws a banner picture without posting anything, so its PNG can be looked at. Returns its path.
__attribute__((visibility("default"))) const char *jefi_notifications_test_image(const char *spec) {
  static char path[1024];
  NSURL *url = spec ? jefiNotificationImage([NSString stringWithUTF8String:spec]) : nil;
  if (!url) return NULL;
  strlcpy(path, url.fileSystemRepresentation, sizeof path);
  return path;
}

__attribute__((visibility("default"))) bool jefi_notifications_test_open_event(const char *event_id, const char *occurrence_start) {
  if (!bridge || !event_id || !occurrence_start) return false;
  [bridge openEventId:[NSString stringWithUTF8String:event_id] occurrenceStart:[NSString stringWithUTF8String:occurrence_start] completion:^{}];
  return true;
}

// Built only by the local smoke test: exercises the same retained main-queue callback path without
// asking the developer's Mac for notification permission or posting a real banner.
__attribute__((visibility("default"))) bool jefi_notifications_test_open(const char *account_id, const char *thread_id) {
  if (!bridge || !account_id || !thread_id) return false;
  NSString *accountId = [NSString stringWithUTF8String:account_id];
  NSString *threadId = [NSString stringWithUTF8String:thread_id];
  if (!accountId || !threadId) return false;
  [bridge openAccountId:accountId threadId:threadId completion:^{}];
  return true;
}

__attribute__((visibility("default"))) bool jefi_notifications_test_open_background(const char *account_id, const char *thread_id) {
  if (!bridge || !account_id || !thread_id) return false;
  NSString *accountId = [NSString stringWithUTF8String:account_id];
  NSString *threadId = [NSString stringWithUTF8String:thread_id];
  if (!accountId || !threadId) return false;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [bridge openAccountId:accountId threadId:threadId completion:^{}];
  });
  return true;
}
#endif
