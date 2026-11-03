import { dirname, resolve } from 'node:path'
import { dlopen, FFIType } from 'bun:ffi'
import { NATIVE_HELPERS, type NativeHelper } from '../native/helpers'

// ---------------------------------------------------------------------------
// `Jefi cli selftest`: internal, for the release workflow, and not part of docs/integrations.md.
// Loads every native helper from the bundle's Frameworks without starting any UI, so a helper the
// hardened runtime refuses (bad signature, wrong team) fails the release before notarization
// instead of on a user's Mac.
// ---------------------------------------------------------------------------

export type HelperResult = { file: string; ok: boolean; error?: string }
export type SelftestResult = { ok: boolean; frameworks: string; helpers: HelperResult[] }

/** Contents/Frameworks beside Contents/MacOS/Jefi; JEFI_FRAMEWORKS points elsewhere for local runs. */
export const bundleFrameworks = (execPath = process.execPath, env: Record<string, string | undefined> = process.env) =>
  env.JEFI_FRAMEWORKS || resolve(dirname(execPath), '..', 'Frameworks')

function load(helper: NativeHelper, path: string) {
  if (helper.kind === 'dylib') {
    // Resolving the symbol needs the library loaded and validated; nothing is called.
    dlopen(path, { [helper.symbol]: { args: [], returns: FFIType.void } }).close()
    return
  }
  const module = { exports: {} as Record<string, unknown> }
  process.dlopen(module, path)
  if (typeof module.exports[helper.symbol] !== 'function') throw new Error(`${helper.symbol} is missing`)
}

export function selftest(frameworks = bundleFrameworks(), helpers = NATIVE_HELPERS): SelftestResult {
  const results = helpers.map((helper): HelperResult => {
    try {
      load(helper, `${frameworks}/${helper.file}`)
      return { file: helper.file, ok: true }
    } catch (err) {
      return { file: helper.file, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  return { ok: results.every((r) => r.ok), frameworks, helpers: results }
}
