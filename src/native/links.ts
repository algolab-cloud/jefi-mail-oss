import { existsSync } from 'node:fs'
import { CString, dlopen, FFIType, JSCallback, type Pointer } from 'bun:ffi'
import { dispatchJefiUrl } from '../deeplink'
import { lifecycleHelperPath } from './app-lifecycle'

// ---------------------------------------------------------------------------
// Receiving jefi:// links. The lifecycle helper (scripts/native/lifecycle.m) owns the kAEGetURL
// handler and calls back on the main thread; links that arrive before this module listens wait
// there, and links that arrive before the workspace exists wait in src/deeplink.ts.
//
// From plain bun there is no bundle to register the scheme, so nothing can send a link; for scripts
// and screenshots, JEFI_OPEN_URL routes one link at startup instead.
// ---------------------------------------------------------------------------

let callback: JSCallback | null = null

/** Installs the handler: call before the first frame so a link that launched Jefi isn't lost. */
export function listenForLinks(env: Record<string, string | undefined> = process.env) {
  if (callback || process.platform !== 'darwin') return
  const path = lifecycleHelperPath()
  if (existsSync(path)) {
    try {
      const { symbols } = dlopen(path, {
        jefi_links_listen: { args: [FFIType.ptr], returns: FFIType.void },
      })
      // The URL pointer is valid only during this call, so it's copied into a JS string at once.
      callback = new JSCallback((url: Pointer | null) => url && dispatchJefiUrl(new CString(url).toString()), {
        args: [FFIType.ptr],
        returns: FFIType.void,
      })
      symbols.jefi_links_listen(callback.ptr)
    } catch {
      callback?.close()
      callback = null
    }
  }
  if (env.JEFI_OPEN_URL) dispatchJefiUrl(env.JEFI_OPEN_URL)
}
