import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { alignStringTable } from './macho-align'

const require = createRequire(import.meta.url)

const ROOT = resolve(import.meta.dir, '../..')
const SOURCE = join(ROOT, '.cache/gpuix-native-0.8.0-link-events')
const TARGET = join(ROOT, '.cache/gpuix-native-0.8.0-target')
const PATCH = join(ROOT, 'patches/gpuix-native-0.8.0-link-events.patch')
const OUTPUT = join(ROOT, 'build/native/gpuix-native.darwin-arm64.node')
const OUTPUT_STAMP = join(ROOT, 'build/native/gpuix-native.darwin-arm64.node.json')
const STAMP = join(SOURCE, '.jefi-link-events-stamp')
const GPUIX_TAG = '@gpuix/native@0.8.0'
const GPUIX_COMMIT = '8d3ec094387152558d05a5b37de3cfbfca5d2d0a'
const PATCHED_FILES = [
  'packages/native/Cargo.toml',
  'packages/native/src/lib.rs',
  'packages/native/src/renderer.rs',
  'packages/native/src/test_renderer.rs',
  'packages/native/src/custom_elements/img.rs',
  'packages/native/src/custom_elements/markdown.rs',
  'packages/native/src/markdown/render.rs',
  'packages/native/src/text/mod.rs',
  'packages/native/src/text/paint.rs',
  'zed/crates/gpui_apple/src/metal_atlas.rs',
]
// Git reports a dirty submodule by its root path, while --submodule=diff
// expands the exact nested file into the reproducibility patch.
const PATCHED_PATHS = [...new Set(PATCHED_FILES.map((file) => file.startsWith('zed/') ? 'zed' : file))]

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The Jefi GPUIX link-events addon currently builds for macOS arm64 only.')
}

const run = (args: string[], cwd = ROOT, env: Record<string, string> = {}) => {
  const child = Bun.spawnSync(args, { cwd, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' })
  if (child.exitCode !== 0) throw new Error(`${args.join(' ')} failed with exit ${child.exitCode}`)
}

const patchHash = createHash('sha256').update(readFileSync(PATCH)).digest('hex')
if (!existsSync(join(SOURCE, '.git')) || !existsSync(STAMP) || readFileSync(STAMP, 'utf8').trim() !== patchHash) {
  rmSync(SOURCE, { recursive: true, force: true })
  mkdirSync(join(ROOT, '.cache'), { recursive: true })
  run(['git', 'clone', '--depth', '1', '--branch', GPUIX_TAG, '--recurse-submodules', '--shallow-submodules', 'https://github.com/remorses/gpuix.git', SOURCE])
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: SOURCE }).stdout.toString().trim()
  if (head !== GPUIX_COMMIT) throw new Error(`Expected GPUIX ${GPUIX_COMMIT}; cloned ${head}`)
  run(['git', 'apply', '--check', PATCH], SOURCE)
  run(['git', 'apply', PATCH], SOURCE)
  writeFileSync(STAMP, `${patchHash}\n`)
}

const sourceHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: SOURCE }).stdout.toString().trim()
if (sourceHead !== GPUIX_COMMIT) throw new Error(`Expected cached GPUIX ${GPUIX_COMMIT}; found ${sourceHead}`)
const appliedPatch = Bun.spawnSync(['git', 'diff', '--submodule=diff', '--', ...PATCHED_PATHS], { cwd: SOURCE })
if (appliedPatch.exitCode !== 0) throw new Error('Could not inspect the cached GPUIX source patch.')
const appliedPatchHash = createHash('sha256').update(appliedPatch.stdout).digest('hex')
if (appliedPatchHash !== patchHash) {
  throw new Error('Cached GPUIX source differs from the tracked link-events patch. Remove the source cache and rebuild.')
}
const changedFiles = Bun.spawnSync(['git', 'diff', '--name-only'], { cwd: SOURCE }).stdout.toString().trim().split('\n').filter(Boolean)
if (changedFiles.some((file) => !PATCHED_PATHS.includes(file))) {
  throw new Error(`Cached GPUIX source contains unrelated tracked changes: ${changedFiles.join(', ')}`)
}
const untrackedFiles = Bun.spawnSync(['git', 'ls-files', '--others', '--exclude-standard'], { cwd: SOURCE }).stdout.toString().trim().split('\n').filter(Boolean)
if (untrackedFiles.some((file) => file !== '.jefi-link-events-stamp')) {
  throw new Error(`Cached GPUIX source contains unrelated untracked files: ${untrackedFiles.join(', ')}`)
}

const commandLineTools = '/Library/Developer/CommandLineTools'
const nativeEnv: Record<string, string> = { MACOSX_DEPLOYMENT_TARGET: '11.0' }
nativeEnv.CARGO_TARGET_DIR = TARGET
nativeEnv.CARGO_BUILD_JOBS = process.env.CARGO_BUILD_JOBS ?? '2'
if (!process.env.DEVELOPER_DIR && existsSync(commandLineTools)) {
  nativeEnv.DEVELOPER_DIR = commandLineTools
}
if (!process.env.SDKROOT && nativeEnv.DEVELOPER_DIR === commandLineTools) {
  nativeEnv.SDKROOT = join(commandLineTools, 'SDKs/MacOSX.sdk')
}
if (!process.env.CC && nativeEnv.DEVELOPER_DIR === commandLineTools) {
  nativeEnv.CC = join(commandLineTools, 'usr/bin/clang')
}
if (!process.env.CXX && nativeEnv.DEVELOPER_DIR === commandLineTools) {
  nativeEnv.CXX = join(commandLineTools, 'usr/bin/clang++')
}
run(['cargo', 'build', '--locked', '--release', '--features', 'test-support'], join(SOURCE, 'packages/native'), nativeEnv)

const built = join(TARGET, 'release/libgpuix_native.dylib')
if (!existsSync(built)) throw new Error(`Cargo completed without producing ${built}`)
mkdirSync(join(ROOT, 'build/native'), { recursive: true })
copyFileSync(built, OUTPUT)
// macOS 27's linker can leave the string table 4-aligned, which its dyld then refuses to load
// (lume-71l). Move it onto an 8-byte boundary and sign the addon again; aligned builds are untouched.
if (process.platform === 'darwin') {
  run(['codesign', '--remove-signature', OUTPUT], ROOT)
  const aligned = alignStringTable(readFileSync(OUTPUT))
  if (aligned) writeFileSync(OUTPUT, aligned)
  run(['codesign', '--force', '--sign', '-', OUTPUT], ROOT)
}

const binding = require(OUTPUT) as {
  markdownLinkEventsVersion?: () => number
  imageDataUrlReleaseVersion?: () => number
  GpuixRenderer?: { prototype?: { releaseImageDataUrl?: unknown } }
}
if (binding.markdownLinkEventsVersion?.() !== 1) {
  throw new Error('Built GPUIX addon does not expose Markdown link events feature level 1.')
}
if (binding.imageDataUrlReleaseVersion?.() !== 1 ||
    typeof binding.GpuixRenderer?.prototype?.releaseImageDataUrl !== 'function') {
  throw new Error('Built GPUIX addon does not expose data-URL image release feature level 1.')
}
const binaryHash = createHash('sha256').update(readFileSync(OUTPUT)).digest('hex')
writeFileSync(OUTPUT_STAMP, `${JSON.stringify({
  sourceCommit: GPUIX_COMMIT,
  patchSha256: patchHash,
  binarySha256: binaryHash,
  markdownLinkEventsVersion: 1,
  imageDataUrlReleaseVersion: 1,
}, null, 2)}\n`)
console.log(OUTPUT)
