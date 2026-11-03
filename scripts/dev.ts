/**
 * `bun run dev`: runs Jefi from source inside build/dev/Jefi Dev.app, so macOS treats it like the real
 * app. Notifications go through UserNotifications with the Jefi icon and route clicks, and the Dock
 * says "Jefi Mail", like the release app. The bundle's executable is a copy of this bun, so `--hot`
 * works as before.
 *
 * The bundle is only rebuilt when bun, the GPUIX addon, the native helpers, or the icons change. If
 * it can't be built, Jefi runs on plain bun as it used to (notifications then fall back to osascript).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { buildNativeHelpers, helperSources, infoPlist, jefiUrlTypes, MINIMUM_MACOS } from './native/build-helpers'
import { APP_NAME } from '../src/version'

const ROOT = resolve(import.meta.dir, '..')
const APP = `${ROOT}/build/dev/Jefi Dev.app`
const EXE = `${APP}/Contents/MacOS/Jefi Dev`
const STAMP = `${APP}/Contents/.inputs`
const ICONS = `${ROOT}/brand/app-icon`
const GPUIX = `${ROOT}/build/native/gpuix-native.darwin-arm64.node`

/** Everything the bundle is made of. Big binaries are keyed by path, size and mtime: hashing them each run is slow. */
function inputsKey() {
  const hash = createHash('sha256')
  for (const file of [process.execPath, GPUIX]) {
    const { size, mtimeMs } = statSync(file)
    hash.update(`${file}:${size}:${mtimeMs}\n`)
  }
  const icons = readdirSync(ICONS).filter((name) => name === 'AppIcon.icns' || /^icon-.*1024\.png$/.test(name)).sort()
  for (const file of [...helperSources, import.meta.path, ...icons.map((name) => `${ICONS}/${name}`)]) {
    hash.update(`${file}\n`).update(readFileSync(file))
  }
  return hash.digest('hex')
}

/**
 * A signing identity that stays the same across rebuilds: JEFI_DEV_SIGN_IDENTITY, else the first
 * Apple Development certificate in the login Keychain, else ad hoc ("-") on a Mac without one.
 */
function signingIdentity() {
  if (process.env.JEFI_DEV_SIGN_IDENTITY) return process.env.JEFI_DEV_SIGN_IDENTITY
  try {
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    return identities.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Development:/m)?.[1] ?? '-'
  } catch {
    return '-'
  }
}

function assemble() {
  if (!existsSync(`${ICONS}/AppIcon.icns`)) execFileSync('bun', ['scripts/brand.ts'], { cwd: ROOT, stdio: 'inherit' })
  const key = inputsKey()
  if (existsSync(EXE) && existsSync(STAMP) && readFileSync(STAMP, 'utf8') === key) return
  console.log('dev: assembling build/dev/Jefi Dev.app')
  rmSync(APP, { recursive: true, force: true })
  for (const dir of ['MacOS', 'Frameworks', 'Resources']) mkdirSync(`${APP}/Contents/${dir}`, { recursive: true })
  // A copy, not a hard link: signing the bundle rewrites the executable, which must not touch the real bun.
  copyFileSync(process.execPath, EXE)
  // Inside a bundle the GPUIX loader only looks in Frameworks, as in the release app.
  copyFileSync(GPUIX, `${APP}/Contents/Frameworks/gpuix-native.darwin-arm64.node`)
  buildNativeHelpers(`${APP}/Contents/Frameworks`)
  // src/dock-icon.ts reads the accent icons from Resources when running from a bundle.
  for (const name of readdirSync(ICONS).filter((name) => name === 'AppIcon.icns' || /^icon-.*1024\.png$/.test(name))) {
    copyFileSync(`${ICONS}/${name}`, `${APP}/Contents/Resources/${name}`)
  }
  // A bundle id apart from the release app's, so notification permission and settings don't collide.
  // Named like the release app; the bundle and executable keep "Jefi Dev" so the Keychain, which
  // trusts the app it allowed by its path, doesn't ask again.
  writeFileSync(`${APP}/Contents/Info.plist`, infoPlist({
    CFBundleName: APP_NAME,
    CFBundleDisplayName: APP_NAME,
    CFBundleIdentifier: 'app.jefi.mail.dev',
    CFBundleExecutable: 'Jefi Dev',
    CFBundleIconFile: 'AppIcon',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: '0.0.0',
    CFBundleVersion: '0',
    CFBundleInfoDictionaryVersion: '6.0',
    LSMinimumSystemVersion: MINIMUM_MACOS,
    LSUIElement: false,
    NSHighResolutionCapable: true,
    // jefi:// links reach this app while it runs; launched cold it would start a bare bun, not Jefi.
    CFBundleURLTypes: jefiUrlTypes('app.jefi.mail.dev'),
  }))
  writeFileSync(`${APP}/Contents/PkgInfo`, 'APPL????')
  // Keeping bun's own entitlements (JIT) so the copy behaves like bun. Keychain trusts an app by its
  // signature: an ad hoc one changes with every rebuild, so each rebuild asked for the Keychain again.
  execFileSync('codesign', ['--force', '--deep', '--sign', signingIdentity(), '--preserve-metadata=entitlements', APP], { stdio: 'inherit' })
  execFileSync('touch', [APP])
  writeFileSync(STAMP, key)
}

let runtime = process.execPath
try {
  assemble()
  runtime = EXE
} catch (error) {
  console.warn(`dev: could not build Jefi Dev.app, running on plain bun (notifications will use osascript): ${error instanceof Error ? error.message : error}`)
}

const child = Bun.spawn([runtime, '--hot', 'src/mail.tsx', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: `${ROOT}/build/native/gpuix-native.darwin-arm64.node` },
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))
process.exit(await child.exited)
