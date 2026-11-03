#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// GPUI's macOS view implements NSTextInputClient and forwards these messages to the currently
// focused input entity. Keeping this bridge at the AppKit boundary avoids depending on GPUIX's
// private Rust TextEditorState while still using its native undo, IME and change-event pipeline.
static bool jefi_is_text_input_responder(id responder) {
  return responder &&
      [responder respondsToSelector:@selector(selectedRange)] &&
      [responder respondsToSelector:@selector(attributedSubstringForProposedRange:actualRange:)] &&
      [responder respondsToSelector:@selector(insertText:replacementRange:)];
}

static id jefi_text_input_responder(void) {
  if (![NSThread isMainThread]) return nil;
  NSWindow *window = NSApp.keyWindow ?: NSApp.mainWindow;
  if (window) {
    id responder = window.firstResponder;
    return jefi_is_text_input_responder(responder) ? responder : nil;
  }

  // A window launched for background automation is intentionally neither key nor main. Its GPUI
  // focus is still exact. Accept only one eligible responder inside this process: ambiguity is a
  // hard failure rather than risking an edit in another GPUI window.
  id found = nil;
  for (NSWindow *candidate in NSApp.windows) {
    id responder = candidate.firstResponder;
    if (!jefi_is_text_input_responder(responder)) continue;
    if (found && found != responder) return nil;
    found = responder;
  }
  return found;
}

__attribute__((visibility("default"))) bool jefi_editor_selection(uint64_t *location, uint64_t *length) {
  id responder = jefi_text_input_responder();
  if (!responder || !location || !length) return false;
  NSRange range = ((NSRange (*)(id, SEL))objc_msgSend)(responder, @selector(selectedRange));
  if (range.location == NSNotFound) return false;
  *location = range.location;
  *length = range.length;
  return true;
}

// Returns a caller-owned UTF-8 snapshot of the focused editor plus its selection. JavaScript frees
// it with jefi_editor_free. Reading value and range together avoids formatting a newer native
// selection with an older React render during rapid typing.
__attribute__((visibility("default"))) char *jefi_editor_snapshot(
    uint64_t *responder_identity,
    uint64_t *location,
    uint64_t *length) {
  id responder = jefi_text_input_responder();
  if (!responder || !responder_identity || !location || !length) return NULL;
  NSRange selection = ((NSRange (*)(id, SEL))objc_msgSend)(responder, @selector(selectedRange));
  if (selection.location == NSNotFound) return NULL;

  NSRange actual = NSMakeRange(NSNotFound, 0);
  NSAttributedString *attributed = ((id (*)(id, SEL, NSRange, NSRange *))objc_msgSend)(
      responder,
      @selector(attributedSubstringForProposedRange:actualRange:),
      NSMakeRange(0, NSUIntegerMax),
      &actual);
  if (!attributed || actual.location != 0) return NULL;
  const char *utf8 = attributed.string.UTF8String;
  if (!utf8) return NULL;
  char *copy = strdup(utf8);
  if (!copy) return NULL;
  *responder_identity = (uint64_t)(uintptr_t)(__bridge void *)responder;
  *location = selection.location;
  *length = selection.length;
  return copy;
}

__attribute__((visibility("default"))) void jefi_editor_free(void *pointer) {
  free(pointer);
}

__attribute__((visibility("default"))) bool jefi_editor_replace(
    uint64_t expected_responder_identity,
    uint64_t expected_location,
    uint64_t expected_length,
    uint64_t replacement_location,
    uint64_t replacement_length,
    const char *replacement_utf8) {
  id responder = jefi_text_input_responder();
  if (!responder || !replacement_utf8) return false;
  if ((uint64_t)(uintptr_t)(__bridge void *)responder != expected_responder_identity) return false;

  // The JavaScript side verifies the GPUI host id. Re-check the range here so a focus or selection
  // change between the read and write cannot replace text in a stale location.
  NSRange current = ((NSRange (*)(id, SEL))objc_msgSend)(responder, @selector(selectedRange));
  if (current.location != expected_location || current.length != expected_length) return false;
  if (replacement_location > NSUIntegerMax || replacement_length > NSUIntegerMax - replacement_location) return false;

  NSString *replacement = [NSString stringWithUTF8String:replacement_utf8];
  if (!replacement) return false;
  NSRange range = NSMakeRange((NSUInteger)replacement_location, (NSUInteger)replacement_length);
  ((void (*)(id, SEL, id, NSRange))objc_msgSend)(
      responder, @selector(insertText:replacementRange:), replacement, range);
  return true;
}
