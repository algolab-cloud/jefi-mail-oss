/**
 * Signs, packages and notarizes Jefi: dist/Jefi.app -> dist/Jefi-<version>.dmg, ready to download.
 *
 *   bun scripts/release/sign.ts                 sign and build the DMG (no notarization)
 *   bun scripts/release/sign.ts --notarize      ...and send it to Apple, then staple the ticket
 *   bun scripts/release/sign.ts --notarize-only notarize the DMG an earlier run built, without re-signing
 *
 * CI signs, runs scripts/release/signed-smoke.ts against the signed app, then notarizes with
 * --notarize-only, so what Apple sees is exactly what the smoke test loaded.
 *
 * Signing needs a Developer ID Application certificate in the login keychain; JEFI_SIGN_IDENTITY
 * picks one when there are several. Notarizing needs either a saved notarytool profile
 * (JEFI_NOTARY_PROFILE, made by `xcrun notarytool store-credentials`) or APPLE_ID, APPLE_TEAM_ID
 * and APPLE_APP_SPECIFIC_PASSWORD. CI passes the last three as secrets.
 *
 * JEFI_PROVISIONING_PROFILE, when set, is the Developer ID profile granting Communication
 * Notifications (scripts/release/profile.ts): it is embedded and its entitlements added, so banners
 * show the sender's picture in place of the app icon. Without it the app is signed as before.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { NATIVE_HELPERS } from '../../src/native/helpers'
import { bundleIdOf, profileEntitlements, readProfile, withEntitlements } from './profile'

const ROOT = process.cwd()
const APP = `${ROOT}/dist/Jefi.app`
const ENTITLEMENTS = `${ROOT}/scripts/release/entitlements.plist`
const notarizeOnly = process.argv.includes('--notarize-only')
const notarize = notarizeOnly || process.argv.includes('--notarize')

const run = (command: string, args: string[], quiet = false) =>
  execFileSync(command, args, { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
const die = (message: string): never => {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/** The Developer ID to sign with: JEFI_SIGN_IDENTITY, else the only one installed. */
function signingIdentity(): string {
  if (process.env.JEFI_SIGN_IDENTITY) return process.env.JEFI_SIGN_IDENTITY
  const found = [...run('security', ['find-identity', '-v', '-p', 'codesigning'], true).matchAll(/"(Developer ID Application: [^"]+)"/g)].map((m) => m[1]!)
  if (found.length === 0) die('No "Developer ID Application" certificate in the keychain.\nCreate one at developer.apple.com → Certificates, download it, and double-click to install.')
  if (found.length > 1) die(`Several Developer ID certificates are installed. Pick one:\n${found.map((f) => `  JEFI_SIGN_IDENTITY="${f}"`).join('\n')}`)
  return found[0]!
}

if (!existsSync(APP) && !notarizeOnly) run('bun', ['scripts/bundle.ts'])
const version = (JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as { version: string }).version
const dmg = `${ROOT}/dist/Jefi-${version}.dmg`

if (notarizeOnly) {
  if (!existsSync(dmg)) die(`${dmg} doesn't exist. Run bun scripts/release/sign.ts first.`)
} else {
  const identity = signingIdentity()
  console.log(`signing ${APP} as ${identity}`)

  // Native code first, then the executable, then the bundle around both: signing the bundle alone
  // leaves its binaries unsigned.
  // --options runtime is the hardened runtime, which notarization requires.
  // Every helper in Frameworks, not a hand-kept list: a new dylib left with only the linker's ad-hoc
  // signature fails library validation under the hardened runtime and is rejected by notarization.
  const frameworks = readdirSync(`${APP}/Contents/Frameworks`).filter((name) => /\.(dylib|node)$/.test(name))
  for (const { file: required } of NATIVE_HELPERS) {
    if (!frameworks.includes(required)) die(`${required} is missing from ${APP}/Contents/Frameworks. Run bun run bundle.`)
  }
  for (const name of frameworks) {
    run('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, `${APP}/Contents/Frameworks/${name}`])
  }
  // The profile and its entitlements go in together or not at all: an entitlement the bundle has no
  // profile for stops the app from launching.
  const embedded = `${APP}/Contents/embedded.provisionprofile`
  const profilePath = process.env.JEFI_PROVISIONING_PROFILE
  let entitlements = ENTITLEMENTS
  rmSync(embedded, { force: true })
  if (profilePath) {
    if (!existsSync(profilePath)) die(`JEFI_PROVISIONING_PROFILE points at ${profilePath}, which doesn't exist.`)
    const bundleId = bundleIdOf(APP) ?? die(`${APP}/Contents/Info.plist has no CFBundleIdentifier.`)
    const extra = profileEntitlements(readProfile(profilePath), bundleId)
    if (typeof extra === 'string') die(`Can't use ${profilePath}: ${extra}.\nRe-run scripts/release/setup-communication-notifications.sh, or unset JEFI_PROVISIONING_PROFILE.`)
    cpSync(profilePath, embedded)
    entitlements = `${mkdtempSync(`${tmpdir()}/jefi-entitlements-`)}/entitlements.plist`
    writeFileSync(entitlements, withEntitlements(readFileSync(ENTITLEMENTS, 'utf8'), extra as Record<string, string | boolean>))
    console.log(`embedding ${profilePath}: communication notifications on`)
  } else {
    console.log('no JEFI_PROVISIONING_PROFILE: banners keep the app icon, with the picture as a thumbnail')
  }
  run('codesign', ['--force', '--timestamp', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity, `${APP}/Contents/MacOS/Jefi`])
  run('codesign', ['--force', '--timestamp', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity, APP])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP])

  // A DMG with the app and a shortcut to Applications: the usual "drag it across" window.
  const stage = mkdtempSync(`${tmpdir()}/jefi-dmg-`)
  try {
    cpSync(APP, `${stage}/Jefi.app`, { recursive: true })
    symlinkSync('/Applications', `${stage}/Applications`)
    rmSync(dmg, { force: true })
    run('hdiutil', ['create', '-volname', 'Jefi Mail', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg])
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  run('codesign', ['--force', '--timestamp', '--sign', identity, dmg])
}

if (!notarize) {
  console.log(`\nbuilt ${dmg}`)
  console.log('Not notarized: macOS will warn on another Mac. Run again with --notarize to send it to Apple.')
  process.exit(0)
}

/** How to prove who we are to notarytool: a saved profile, or an Apple ID and app-specific password. */
const credentials = process.env.JEFI_NOTARY_PROFILE
  ? ['--keychain-profile', process.env.JEFI_NOTARY_PROFILE]
  : process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD
    ? ['--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD]
    : die(
        'Notarizing needs credentials. Either:\n' +
          '  xcrun notarytool store-credentials jefi --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-password>\n' +
          '  export JEFI_NOTARY_PROFILE=jefi\n' +
          'or set APPLE_ID, APPLE_TEAM_ID and APPLE_APP_SPECIFIC_PASSWORD.\n' +
          'App-specific passwords come from appleid.apple.com → Sign-In and Security.',
      )

// Apple usually answers in a few minutes; the wait is the whole point of doing this before a launch.
console.log('\nsending to Apple for notarization (this usually takes a few minutes)…')
run('xcrun', ['notarytool', 'submit', dmg, ...credentials, '--wait', '--timeout', '30m'])
// Stapling puts the ticket inside the DMG, so it opens cleanly on a Mac that is offline.
run('xcrun', ['stapler', 'staple', dmg])
run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose', dmg])
console.log(`\nnotarized and stapled: ${dmg}`)
