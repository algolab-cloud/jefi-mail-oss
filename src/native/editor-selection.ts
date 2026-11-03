import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CString, dlopen, FFIType, ptr, type Pointer } from 'bun:ffi'

export type EditorSelection = { location: number; length: number }
export type EditorSnapshot = EditorSelection & { responderIdentity: bigint; value: string }
export type EditorReplacement = { range: EditorSelection; text: string }

export const nativeEditorAvailable = process.platform === 'darwin' && process.arch === 'arm64'

/** Location installed by scripts/bundle.ts; the override is for the native smoke test only. */
export function editorHelperPath(execPath = process.execPath) {
  return process.env.JEFI_EDITOR_HELPER_PATH || resolve(dirname(execPath), '..', 'Frameworks', 'libJefiEditor.dylib')
}

const openEditorLibrary = (path: string) =>
  dlopen(path, {
    jefi_editor_selection: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    jefi_editor_snapshot: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    jefi_editor_free: { args: [FFIType.ptr], returns: FFIType.void },
    jefi_editor_replace: {
      args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.cstring],
      returns: FFIType.bool,
    },
  })

type EditorLibrary = ReturnType<typeof openEditorLibrary>
let nativeLibrary: EditorLibrary | null | undefined

function editorLibrary() {
  if (nativeLibrary !== undefined) return nativeLibrary
  if (!nativeEditorAvailable) return (nativeLibrary = null)
  const path = editorHelperPath()
  if (!existsSync(path)) return (nativeLibrary = null)
  try {
    return (nativeLibrary = openEditorLibrary(path))
  } catch {
    return (nativeLibrary = null)
  }
}

/** Reads the focused AppKit text client's UTF-16 selection. */
export function readEditorSelection(): EditorSelection | null {
  const library = editorLibrary()
  if (!library) return null
  const location = new BigUint64Array(1)
  const length = new BigUint64Array(1)
  if (!library.symbols.jefi_editor_selection(ptr(location), ptr(length))) return null
  const start = Number(location[0])
  const size = Number(length[0])
  return Number.isSafeInteger(start) && Number.isSafeInteger(size) ? { location: start, length: size } : null
}

/** Reads the focused editor value and UTF-16 selection in one native snapshot. */
export function readEditorSnapshot(): EditorSnapshot | null {
  const library = editorLibrary()
  if (!library) return null
  const location = new BigUint64Array(1)
  const length = new BigUint64Array(1)
  const responderIdentity = new BigUint64Array(1)
  const valuePointer = library.symbols.jefi_editor_snapshot(ptr(responderIdentity), ptr(location), ptr(length)) as Pointer | null
  if (!valuePointer) return null
  try {
    const start = Number(location[0])
    const size = Number(length[0])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size)) return null
    return { responderIdentity: responderIdentity[0], location: start, length: size, value: new CString(valuePointer).toString() }
  } finally {
    library.symbols.jefi_editor_free(valuePointer)
  }
}

/** Replaces only if the focused text client's selection still matches `expected`. */
export function replaceEditorSelection(expected: EditorSelection & { responderIdentity?: bigint }, replacement: EditorReplacement) {
  const library = editorLibrary()
  if (!library || expected.responderIdentity === undefined || replacement.text.includes('\0')) return false
  const utf8 = Buffer.from(`${replacement.text}\0`, 'utf8')
  try {
    return library.symbols.jefi_editor_replace(
      expected.responderIdentity,
      expected.location,
      expected.length,
      replacement.range.location,
      replacement.range.length,
      utf8,
    )
  } catch {
    return false
  }
}
