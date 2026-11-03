import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { dlopen, FFIType, JSCallback, toArrayBuffer, type Pointer } from 'bun:ffi'

const MAX_PNG_BYTES = 24 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const mailSnapshotAvailable = process.platform === 'darwin' && process.arch === 'arm64'

/** Bundled helper first; development may use the reproducible build output in this checkout. */
export function mailSnapshotHelperPath(execPath = process.execPath, cwd = process.cwd()) {
  const executableDirectory = dirname(execPath)
  if (executableDirectory.endsWith('/Contents/MacOS')) {
    return resolve(executableDirectory, '..', 'Frameworks', 'libJefiMailSnapshot.dylib')
  }
  return process.env.JEFI_MAIL_SNAPSHOT_HELPER_PATH || resolve(cwd, 'build', 'native', 'libJefiMailSnapshot.dylib')
}

/** Copies and validates borrowed PNG bytes before the native completion block returns. */
export function pngDataUrl(bytes: Uint8Array): string | null {
  if (bytes.byteLength < PNG_SIGNATURE.length || bytes.byteLength > MAX_PNG_BYTES) return null
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

const openSnapshotLibrary = (path: string) =>
  dlopen(path, {
    jefi_mail_snapshot: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.void,
    },
  })

type SnapshotLibrary = ReturnType<typeof openSnapshotLibrary>
let library: SnapshotLibrary | null | undefined
let callback: JSCallback | null = null
let nextRequestId = 1
const pending = new Map<number, (snapshot: string | null) => void>()

function snapshotLibrary() {
  if (library !== undefined) return library
  if (!mailSnapshotAvailable) return (library = null)
  const path = mailSnapshotHelperPath()
  if (!existsSync(path)) return (library = null)
  try {
    const opened = openSnapshotLibrary(path)
    callback = new JSCallback(
      (requestId: number, bytesPointer: Pointer | null, lengthValue: number | bigint) => {
        const finish = pending.get(requestId)
        if (!finish) return
        pending.delete(requestId)
        const length = Number(lengthValue)
        if (!bytesPointer || !Number.isSafeInteger(length) || length < PNG_SIGNATURE.length || length > MAX_PNG_BYTES) {
          finish(null)
          return
        }
        try {
          // WebKit owns this memory only until this callback returns, so make an immediate copy.
          const bytes = new Uint8Array(toArrayBuffer(bytesPointer, 0, length)).slice()
          finish(pngDataUrl(bytes))
        } catch {
          finish(null)
        }
      },
      { args: [FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.void },
    )
    library = opened
    return opened
  } catch {
    callback?.close()
    callback = null
    return (library = null)
  }
}

function requestId() {
  const id = nextRequestId
  nextRequestId = nextRequestId === 0xffff_ffff ? 1 : nextRequestId + 1
  return id
}

/** Takes a public WKWebView snapshot. A late callback is ignored after the bounded timeout. */
export function snapshotMailWebView(webView: Pointer | bigint, timeoutMs = 1_000): Promise<string | null> {
  const native = snapshotLibrary()
  const nativeCallback = callback
  if (!native || !nativeCallback || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(null)
  const id = requestId()
  return new Promise((finish) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const complete = (snapshot: string | null) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      finish(snapshot)
    }
    pending.set(id, complete)
    timeout = setTimeout(() => {
      pending.delete(id)
      complete(null)
    }, timeoutMs)
    try {
      native.symbols.jefi_mail_snapshot(webView, id, nativeCallback.ptr)
    } catch {
      pending.delete(id)
      complete(null)
    }
  })
}
