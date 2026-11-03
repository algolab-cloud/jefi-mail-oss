# GPUIX Markdown link events

Jefi keeps GPUIX's native Markdown renderer for its wrapping, typography, selection, code,
table, list, and emoji behavior. The published GPUIX 0.8.0 addon reports link clicks but does
not expose the retained link ranges for pointer hover or keyboard focus. The patch at
`patches/gpuix-native-0.8.0-link-events.patch` adds three events without changing Markdown
parsing or text layout:

- `linkHover` reports the exact destination and measured window position under the pointer.
- `linkFocus` and `linkBlur` expose a tab stop and stable flattened-range ordinal for each inline
  destination, so separate links remain distinct even when their URLs are identical.
- Enter or Space on a focused link uses the existing `linkClick` event, so Jefi's review
  popover remains the only route that can open the destination.

## Reproducible build

Run `bun run native:links` on macOS arm64. The script clones the exact GPUIX 0.8.0 commit,
initializes its exact Zed/GPUI submodule, verifies the commit, checks and applies Jefi's patch,
uses the upstream tracked `packages/native/Cargo.lock` with Cargo's `--locked` flag, and builds
`build/native/gpuix-native.darwin-arm64.node`. Compiled dependencies live in a separate
`.cache/gpuix-native-0.8.0-target` directory, so changing the patch refreshes source without
discarding the expensive dependency build. The generated addon is ignored by
Git. Its exported `markdownLinkEventsVersion()` must return `1`; the build fails if it does
not, preventing a stock addon from being mistaken for the patched build. Every run also
rechecks the cached source commit, exact applied-patch hash, and absence of unrelated tracked
or untracked source changes. The adjacent JSON manifest records the source commit, patch hash,
binary hash, and feature level for bundle-time verification.

An explicitly supplied `DEVELOPER_DIR` or `SDKROOT` is preserved. Otherwise, the selected full
Xcode on some developer Macs can be unavailable before its license is
accepted. The build uses the separately installed Apple Command Line Tools and SDK when they
exist. Those tools do not include Apple's optional offline Metal compiler, so this generated
addon enables GPUI's supported `runtime_shaders` feature. GPUI compiles the same checked-in
shader source through Metal when the renderer starts; the Markdown layout and rendering path
are unchanged. Validation must include app startup and a rendered frame.

The release addon includes GPUIX's `test-support` feature so the same binary can run native
layout, input, selection, and screenshot regressions before packaging. That feature exports an
in-process test renderer; it does not start an automation listener or expose a network service.

The bundle copies the generated addon into `Jefi.app/Contents/Frameworks`, copies the GPUIX
license into `Contents/Resources`, and signs the addon with the other native code. In a bundled
app the patched `@gpuix/native` loader requires that exact Frameworks file and feature level
`1`; a missing or stock addon fails closed. Local development uses
`NAPI_RS_NATIVE_LIBRARY_PATH` to select the same generated addon explicitly.

## Required validation

The native test must cover a wrapped link preceded by emoji, pointer hover disclosure,
Tab and Shift-Tab focus across repeated destinations, Enter activation through the review
callback, and drag selection across link text.
The hover and focus path performs only local URL assessment; it must make no network request.
An actual-window screenshot verifies the disclosure position and unchanged native Markdown
appearance. The stock accessible destination list remains available as a redundant keyboard
surface.
