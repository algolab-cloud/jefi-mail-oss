/**
 * Packages Jefi as a macOS app: dist/Jefi.app with the brand icon and a proper Info.plist, so
 * Finder, the Dock, and the menu bar all say "Jefi Mail". The bundle and executable keep the name
 * Jefi: updates, the CLI and the Raycast extension find the app at Jefi.app/Contents/MacOS/Jefi.
 *
 *   bun run bundle
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { buildNativeHelpers, infoPlist, jefiUrlTypes, MINIMUM_MACOS } from './native/build-helpers'
import { APP_NAME } from '../src/version'

const ROOT = process.cwd()
const APP = `${ROOT}/dist/Jefi.app`
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as { version: string }
const gpuixAddon = `${ROOT}/build/native/gpuix-native.darwin-arm64.node`
const gpuixManifest = `${gpuixAddon}.json`
const gpuixPatch = `${ROOT}/patches/gpuix-native-0.8.0-link-events.patch`
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

if (!existsSync(`${ROOT}/brand/app-icon/AppIcon.icns`) || !existsSync(`${ROOT}/brand/app-icon/icon-violet-1024.png`)) {
  execFileSync('bun', ['scripts/brand.ts'], { stdio: 'inherit' })
}

// Build and verify the app-owned GPUIX addon before deleting a previously working bundle.
// The manifest binds the tracked source patch to the exact binary copied below; loading it here
// independently verifies that the artifact also exposes Jefi's required feature marker.
execFileSync('bun', ['scripts/native/build-gpuix-link-events.ts'], { stdio: 'inherit' })
const manifest: unknown = JSON.parse(readFileSync(gpuixManifest, 'utf8'))
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('The GPUIX native addon manifest is invalid.')
const nativeBuild = manifest as Record<string, unknown>
if (nativeBuild.patchSha256 !== sha256(gpuixPatch)) throw new Error('The GPUIX native addon does not match the tracked source patch.')
if (nativeBuild.binarySha256 !== sha256(gpuixAddon)) throw new Error('The GPUIX native addon checksum does not match its build manifest.')
const gpuixBinding = createRequire(import.meta.url)(gpuixAddon) as {
  markdownLinkEventsVersion?: () => number
  imageDataUrlReleaseVersion?: () => number
  GpuixRenderer?: { prototype?: { releaseImageDataUrl?: unknown } }
}
if (nativeBuild.markdownLinkEventsVersion !== 1 || gpuixBinding.markdownLinkEventsVersion?.() !== 1) {
  throw new Error('The GPUIX native addon does not expose Markdown link events feature level 1.')
}
if (nativeBuild.imageDataUrlReleaseVersion !== 1 || gpuixBinding.imageDataUrlReleaseVersion?.() !== 1 ||
    typeof gpuixBinding.GpuixRenderer?.prototype?.releaseImageDataUrl !== 'function') {
  throw new Error('The GPUIX native addon cannot release temporary email canvas images.')
}

rmSync(APP, { recursive: true, force: true })
mkdirSync(`${APP}/Contents/MacOS`, { recursive: true })
mkdirSync(`${APP}/Contents/Frameworks`, { recursive: true })
mkdirSync(`${APP}/Contents/Resources`, { recursive: true })
cpSync(gpuixAddon, `${APP}/Contents/Frameworks/gpuix-native.darwin-arm64.node`)

buildNativeHelpers(`${APP}/Contents/Frameworks`)

// The engine and phishing-list workers are separate entrypoints so `new Worker()` can resolve them inside the binary.
// NODE_ENV is fixed at build time: without the define bun bakes in "development", and the app ships
// React's development builds (dev reconciler with its extra checks, owner stacks and render tracking).
execFileSync('bun', ['build', '--compile', '--define', 'process.env.NODE_ENV="production"', 'src/mail.tsx', 'src/engine/worker.ts', 'src/phishing-worker.ts', '--outfile', `${APP}/Contents/MacOS/Jefi`], { stdio: 'inherit' })
cpSync(`${ROOT}/brand/app-icon/AppIcon.icns`, `${APP}/Contents/Resources/AppIcon.icns`)
cpSync(`${ROOT}/LICENSE`, `${APP}/Contents/Resources/LICENSE`)
cpSync(`${ROOT}/THIRD_PARTY_NOTICES.md`, `${APP}/Contents/Resources/THIRD_PARTY_NOTICES.md`)
cpSync(`${ROOT}/docs/licenses/gpuix-APACHE-2.0.txt`, `${APP}/Contents/Resources/GPUIX-APACHE-2.0.txt`)
cpSync(`${ROOT}/docs/licenses/comet-MIT.txt`, `${APP}/Contents/Resources/Comet-MIT.txt`)
// Dock icons, one per accent: the running app swaps to the selected accent's icon.
for (const file of readdirSync(`${ROOT}/brand/app-icon`).filter((name) => /^icon-.*1024\.png$/.test(name))) {
  cpSync(`${ROOT}/brand/app-icon/${file}`, `${APP}/Contents/Resources/${file}`)
}

const plist = {
  CFBundleName: APP_NAME,
  CFBundleDisplayName: APP_NAME,
  // Finder and the Dock show the file name (Jefi) unless the display name is localized.
  LSHasLocalizedDisplayName: true,
  CFBundleIdentifier: 'app.jefi.mail',
  CFBundleExecutable: 'Jefi',
  CFBundleIconFile: 'AppIcon',
  CFBundlePackageType: 'APPL',
  CFBundleShortVersionString: pkg.version,
  CFBundleVersion: pkg.version,
  CFBundleInfoDictionaryVersion: '6.0',
  LSMinimumSystemVersion: MINIMUM_MACOS,
  LSApplicationCategoryType: 'public.app-category.productivity',
  NSHighResolutionCapable: true,
  NSHumanReadableCopyright: `© ${new Date().getFullYear()} Jefi`,
  CFBundleURLTypes: jefiUrlTypes('app.jefi.mail'),
  // Banners are sent as incoming messages so the sender's picture replaces the app icon
  // (notifications.m); macOS takes the intent only from an app that declares it.
  NSUserActivityTypes: ['INSendMessageIntent'],
}
writeFileSync(`${APP}/Contents/Info.plist`, infoPlist(plist))
mkdirSync(`${APP}/Contents/Resources/en.lproj`, { recursive: true })
writeFileSync(`${APP}/Contents/Resources/en.lproj/InfoPlist.strings`, `CFBundleName = "${APP_NAME}";\nCFBundleDisplayName = "${APP_NAME}";\n`)
writeFileSync(`${APP}/Contents/PkgInfo`, 'APPL????')
// Nudge Finder/LaunchServices to pick up the new icon.
execFileSync('touch', [APP])
console.log(`built ${APP}`)
