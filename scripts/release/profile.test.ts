import { expect, test } from 'bun:test'
import { COMMUNICATION_ENTITLEMENT, profileEntitlements, withEntitlements, type Profile } from './profile'

const now = new Date('2026-10-01T00:00:00Z')
const profile = (entitlements: Record<string, unknown>, expires = '2027-10-01T00:00:00Z'): Profile => ({
  entitlements,
  teams: ['TEAM123'],
  expires: new Date(expires),
})
const granted = { 'com.apple.application-identifier': 'TEAM123.app.jefi.mail', 'com.apple.developer.team-identifier': 'TEAM123', [COMMUNICATION_ENTITLEMENT]: true }

test("a matching profile signs with its app id, team and the communication entitlement", () => {
  expect(profileEntitlements(profile(granted), 'app.jefi.mail', now)).toEqual(granted)
})

test('a profile for another app, without the capability, or expired is refused with the reason', () => {
  expect(profileEntitlements(profile(granted), 'app.jefi.mail.dev', now)).toContain('not app.jefi.mail.dev')
  expect(profileEntitlements(profile({ ...granted, [COMMUNICATION_ENTITLEMENT]: undefined }), 'app.jefi.mail', now)).toContain("doesn't grant")
  expect(profileEntitlements(profile(granted, '2026-09-01T00:00:00Z'), 'app.jefi.mail', now)).toContain('expired')
  expect(profileEntitlements(profile({ ...granted, 'com.apple.developer.team-identifier': 'OTHER' }), 'app.jefi.mail', now)).toContain("doesn't match")
})

test('the team falls back to TeamIdentifier when the entitlements leave it out', () => {
  const { 'com.apple.developer.team-identifier': _, ...rest } = granted
  expect(profileEntitlements(profile(rest), 'app.jefi.mail', now)).toEqual(granted)
})

test('extra entitlements go inside the base plist dict, escaped', () => {
  const base = '<plist version="1.0">\n<dict>\n  <key>com.apple.security.cs.allow-jit</key>\n  <true/>\n</dict>\n</plist>\n'
  const out = withEntitlements(base, { a: true, b: 'T.x&y' })
  expect(out).toBe(
    '<plist version="1.0">\n<dict>\n  <key>com.apple.security.cs.allow-jit</key>\n  <true/>\n  <key>a</key>\n  <true/>\n  <key>b</key>\n  <string>T.x&amp;y</string>\n</dict>\n</plist>\n',
  )
})
