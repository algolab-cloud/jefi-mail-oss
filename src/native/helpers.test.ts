import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runCli } from '../headless/cli'
import { bundleFrameworks, selftest } from '../headless/selftest'
import { NATIVE_HELPERS } from './helpers'

const read = (path: string) => Bun.file(`${import.meta.dir}/../../${path}`).text()

test('the selftest list is exactly what the bundle puts in Frameworks', async () => {
  const helpers = await read('scripts/native/build-helpers.ts')
  const bundle = await read('scripts/bundle.ts')
  const built = [
    ...[...helpers.matchAll(/dylib\('([^']+\.dylib)'/g)].map((m) => m[1]!),
    ...[...helpers.matchAll(/\/(lib\w+\.dylib)`\)/g)].map((m) => m[1]!),
    ...[...bundle.matchAll(/Contents\/Frameworks\/([\w.-]+\.(?:dylib|node))`/g)].map((m) => m[1]!),
  ]
  expect(NATIVE_HELPERS.map((h) => h.file).sort()).toEqual([...new Set(built)].sort())
})

test('each selftest symbol is one the app loads from that helper', async () => {
  const loaders: Record<string, string> = {
    'libJefiNotifications.dylib': 'src/native/notify.ts',
    'libJefiEditor.dylib': 'src/native/editor-selection.ts',
    'libJefiMailSnapshot.dylib': 'src/native/mail-snapshot.ts',
    'libJefiLifecycle.dylib': 'src/native/app-lifecycle.ts',
    'gpuix-native.darwin-arm64.node': 'scripts/bundle.ts',
  }
  for (const h of NATIVE_HELPERS) expect(await read(loaders[h.file]!)).toContain(h.symbol)
})

test('selftest reports a missing helper per library, and the CLI exits 1', () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-selftest-`)
  try {
    const result = selftest(dir)
    expect(result.ok).toBe(false)
    expect(result.helpers.map((h) => h.file)).toEqual(NATIVE_HELPERS.map((h) => h.file))
    expect(result.helpers.every((h) => !h.ok && h.error)).toBe(true)
    const out = runCli(['selftest', '--json'], { selftest: () => result })
    expect(out.code).toBe(1)
    expect(JSON.parse(out.stdout).helpers).toHaveLength(NATIVE_HELPERS.length)
    expect(runCli(['selftest'], { selftest: () => ({ ok: true, frameworks: dir, helpers: [] }) }).code).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Frameworks is beside the executable unless JEFI_FRAMEWORKS says otherwise', () => {
  expect(bundleFrameworks('/A/Jefi.app/Contents/MacOS/Jefi', {})).toBe('/A/Jefi.app/Contents/Frameworks')
  expect(bundleFrameworks('/x', { JEFI_FRAMEWORKS: '/f' })).toBe('/f')
})
