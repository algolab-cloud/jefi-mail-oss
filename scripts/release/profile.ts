/**
 * The Developer ID provisioning profile that grants Jefi Communication Notifications (made by
 * scripts/release/setup-communication-notifications.sh). sign.ts embeds it as
 * Contents/embedded.provisionprofile and signs with the entitlements it allows. A restricted
 * entitlement without a matching embedded profile stops the app from launching, so these are only
 * ever added together.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

export const COMMUNICATION_ENTITLEMENT = 'com.apple.developer.usernotifications.communication'

/** What sign.ts needs from a profile: its decoded Entitlements, team and expiry. */
export type Profile = { entitlements: Record<string, unknown>; teams: string[]; expires: Date }

/**
 * The entitlements to sign with on top of the base set, or why the profile can't be used. They
 * name the app and team exactly as the profile does; macOS compares the two at launch.
 */
export function profileEntitlements(profile: Profile, bundleId: string, now = new Date()): Record<string, string | boolean> | string {
  const appId = profile.entitlements['com.apple.application-identifier'] ?? profile.entitlements['application-identifier']
  const team = profile.entitlements['com.apple.developer.team-identifier'] ?? profile.teams[0]
  if (typeof appId !== 'string' || !appId.endsWith(`.${bundleId}`)) return `the profile is for ${String(appId)}, not ${bundleId}`
  if (typeof team !== 'string' || !team || appId !== `${team}.${bundleId}`) return `the profile's team ${String(team)} doesn't match its app ${appId}`
  if (profile.entitlements[COMMUNICATION_ENTITLEMENT] !== true) return `the profile doesn't grant ${COMMUNICATION_ENTITLEMENT}`
  if (!(profile.expires.getTime() > now.getTime())) return `the profile expired on ${profile.expires.toISOString()}`
  return {
    'com.apple.application-identifier': appId,
    'com.apple.developer.team-identifier': team,
    [COMMUNICATION_ENTITLEMENT]: true,
  }
}

const escapeXml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The base entitlements plist with `extra` added at the end of its top-level dict. */
export function withEntitlements(base: string, extra: Record<string, string | boolean>): string {
  const close = base.lastIndexOf('</dict>')
  if (close < 0) throw new Error('entitlements plist has no top-level dict')
  const entries = Object.entries(extra)
    .map(([key, value]) => `  <key>${escapeXml(key)}</key>\n  ${typeof value === 'boolean' ? `<${value}/>` : `<string>${escapeXml(value)}</string>`}\n`)
    .join('')
  return `${base.slice(0, close)}${entries}${base.slice(close)}`
}

/** Decodes a .provisionprofile (a signed plist) with the system tools. */
export function readProfile(path: string): Profile {
  const dir = mkdtempSync(`${tmpdir()}/jefi-profile-`)
  try {
    const plist = `${dir}/profile.plist`
    writeFileSync(plist, execFileSync('security', ['cms', '-D', '-i', path]))
    const extract = (key: string, format: 'json' | 'raw') => execFileSync('plutil', ['-extract', key, format, '-o', '-', plist], { encoding: 'utf8' })
    return {
      entitlements: JSON.parse(extract('Entitlements', 'json')) as Record<string, unknown>,
      teams: JSON.parse(extract('TeamIdentifier', 'json')) as string[],
      expires: new Date(extract('ExpirationDate', 'raw').trim()),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The bundle id the app's Info.plist declares. */
export const bundleIdOf = (app: string) =>
  readFileSync(`${app}/Contents/Info.plist`, 'utf8').match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null
