import { expect, test } from 'bun:test'
import { compareVersions, createUpdater, installedBundle, parseManifest, sha256Hex, signedAsJefi, signedByTeam, stagedPath, swapScript, type UpdaterDeps } from './updater'

const DMG = new Uint8Array([1, 2, 3, 4])
const manifest = (over: Record<string, unknown> = {}) => ({ version: '0.2.0', url: 'https://downloads.jefi.app/releases/0.2.0/Jefi-0.2.0.dmg', sha256: sha256Hex(DMG), ...over })

function harness(over: Partial<UpdaterDeps> = {}) {
  const log: string[] = []
  const staged = new Map<string, string>()
  const deps: UpdaterDeps = {
    currentVersion: '0.1.0',
    official: true,
    bundle: '/Applications/Jefi.app',
    fetchManifest: async () => manifest(),
    download: async (url) => (log.push(`download ${url}`), DMG),
    verifyAndStage: async (_dmg, path, version) => (log.push(`stage ${path} ${version}`), void staged.set(path, version)),
    stagedVersion: (path) => staged.get(path) ?? null,
    restartInto: (path, version) => void log.push(`restart ${path} ${version}`),
    ...over,
  }
  const states: string[] = []
  return { updater: createUpdater(deps, (s) => states.push(s.status)), log, staged, states }
}

test('versions compare numerically, not as text', () => {
  expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  expect(compareVersions('0.1.9', '0.2.0')).toBe(-1)
  expect(compareVersions('1.2', '1.2.0')).toBe(0)
  expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(0)
})

test('a manifest is only trusted if it is well-formed, https, and from our download host', () => {
  expect(parseManifest(manifest())).toMatchObject({ version: '0.2.0' })
  expect(parseManifest(manifest({ url: 'http://downloads.jefi.app/x.dmg' }))).toBeNull()
  expect(parseManifest(manifest({ url: 'https://evil.example/Jefi.dmg' }))).toBeNull()
  expect(parseManifest(manifest({ url: 'https://downloads.jefi.app.evil.example/Jefi.dmg' }))).toBeNull()
  expect(parseManifest(manifest({ sha256: 'abc' }))).toBeNull()
  expect(parseManifest(manifest({ version: 'latest' }))).toBeNull()
  expect(parseManifest(null)).toBeNull()
  expect(parseManifest('0.2.0')).toBeNull()
})

test('only an installed copy can replace itself', () => {
  expect(installedBundle('/Applications/Jefi.app/Contents/MacOS/Jefi')).toBe('/Applications/Jefi.app')
  expect(installedBundle('/Users/me/Apps/Jefi.app/Contents/MacOS/Jefi')).toBe('/Users/me/Apps/Jefi.app')
  // From source, and from a quarantined download macOS runs out of a read-only copy.
  expect(installedBundle('/opt/homebrew/bin/bun')).toBeNull()
  expect(installedBundle('/private/var/folders/x/AppTranslocation/ABC/d/Jefi.app/Contents/MacOS/Jefi')).toBeNull()
  expect(installedBundle('/repo/build/dev/Jefi Dev.app/Contents/MacOS/Jefi Dev')).toBeNull()
})

test("the signer must be Jefi's team, exactly", () => {
  expect(signedByTeam('Identifier=app.jefi.mail\nTeamIdentifier=6DQ243QTY2\nSealed Resources=none')).toBe(true)
  expect(signedByTeam('TeamIdentifier=EVIL123456')).toBe(false)
  expect(signedByTeam('TeamIdentifier=not set')).toBe(false)
  // Not fooled by our id appearing somewhere else in the output.
  expect(signedByTeam('Authority=Developer ID Application: Mallory (6DQ243QTY2X)\nTeamIdentifier=MALLORY123')).toBe(false)
  expect(signedByTeam('Info=TeamIdentifier=6DQ243QTY2 (spoofed)\nTeamIdentifier=MALLORY123')).toBe(false)
  expect(signedAsJefi('Identifier=app.jefi.mail\nTeamIdentifier=6DQ243QTY2')).toBe(true)
  expect(signedAsJefi('Identifier=com.example.other\nTeamIdentifier=6DQ243QTY2')).toBe(false)
})

test('a newer version is downloaded, verified, staged, and waits for a restart', async () => {
  const h = harness()
  expect(await h.updater.check()).toEqual({ status: 'ready', version: '0.2.0' })
  expect(h.states).toEqual(['checking', 'downloading', 'ready'])
  expect(h.log).toEqual(['download https://downloads.jefi.app/releases/0.2.0/Jefi-0.2.0.dmg', 'stage /Applications/.Jefi-update.app 0.2.0'])
  expect(h.updater.restartToUpdate()).toBe(true)
  expect(h.log.at(-1)).toBe('restart /Applications/.Jefi-update.app 0.2.0')
})

test('the same or an older version does nothing', async () => {
  for (const version of ['0.1.0', '0.0.9']) {
    const h = harness({ fetchManifest: async () => manifest({ version }) })
    expect((await h.updater.check()).status).toBe('current')
    expect(h.log).toEqual([])
    expect(h.updater.restartToUpdate()).toBe(false)
  }
})

test('a download that does not match its checksum is never staged', async () => {
  const h = harness({ download: async () => new Uint8Array([9, 9, 9]) })
  const state = await h.updater.check()
  expect(state).toMatchObject({ status: 'error' })
  expect(h.log.some((l) => l.startsWith('stage'))).toBe(false)
  expect(h.updater.restartToUpdate()).toBe(false)
})

test('a build that fails the signature check is never offered for install', async () => {
  const h = harness({
    verifyAndStage: async () => {
      throw new Error("The update isn't signed by Jefi")
    },
  })
  expect(await h.updater.check()).toEqual({ status: 'error', message: "The update isn't signed by Jefi" })
  expect(h.updater.restartToUpdate()).toBe(false)
})

test('being offline, or a broken manifest, is quiet and harmless', async () => {
  const offline = harness({
    fetchManifest: async () => {
      throw new TypeError('fetch failed')
    },
  })
  expect((await offline.updater.check()).status).toBe('error')
  expect((await harness({ fetchManifest: async () => ({ nonsense: true }) }).updater.check()).status).toBe('current')
  expect((await harness({ fetchManifest: async () => null }).updater.check()).status).toBe('current')
})

test('running from source points at the download instead of trying to replace itself', async () => {
  const h = harness({ bundle: null })
  expect(await h.updater.check()).toEqual({ status: 'manual', version: '0.2.0', url: manifest().url })
  expect(h.log).toEqual([])
})

test('an update already staged is not downloaded twice', async () => {
  const h = harness()
  h.staged.set('/Applications/.Jefi-update.app', '0.2.0')
  expect((await h.updater.check()).status).toBe('ready')
  expect(h.log).toEqual([])
})

test('at launch, a staged newer build goes in; a stale or missing one is left alone', () => {
  const fresh = harness()
  fresh.staged.set(stagedPath('/Applications/Jefi.app'), '0.2.0')
  expect(fresh.updater.applyStagedAtLaunch()).toBe(true)
  expect(fresh.log).toEqual(['restart /Applications/.Jefi-update.app 0.2.0'])

  const stale = harness()
  stale.staged.set(stagedPath('/Applications/Jefi.app'), '0.1.0') // what we're already running
  expect(stale.updater.applyStagedAtLaunch()).toBe(false)
  expect(harness().updater.applyStagedAtLaunch()).toBe(false)
  expect(harness({ bundle: null }).updater.applyStagedAtLaunch()).toBe(false)
})

test('an invalid or changed staged app is never handed to the restart helper', async () => {
  const atLaunch = harness({ stagedVersion: () => null })
  expect(atLaunch.updater.applyStagedAtLaunch()).toBe(false)
  expect(atLaunch.log).toEqual([])

  const changed = harness()
  expect((await changed.updater.check()).status).toBe('ready')
  changed.staged.set('/Applications/.Jefi-update.app', '9.9.9')
  expect(changed.updater.restartToUpdate()).toBe(false)
  expect(changed.updater.state()).toEqual({ status: 'error', message: 'The staged update could not be verified. Check for updates again.' })
  expect(changed.log.some((line) => line.startsWith('restart'))).toBe(false)
})

test('the swap script re-verifies identity, Gatekeeper and version before replacing Jefi', () => {
  const script = swapScript({ pid: 4242, app: '/Applications/Jefi.app', staged: '/Applications/.Jefi-update.app', backup: '/Applications/.Jefi-previous-123.app', failed: '/Applications/.Jefi-update-failed-123.app', expectedVersion: '0.2.0' })
  const lines = script.split('\n')
  expect(lines[1]).toBe('while /bin/kill -0 4242 2>/dev/null; do /bin/sleep 0.2; done')
  const swap = lines.findIndex((line) => line.startsWith("/bin/mv '/Applications/Jefi.app'"))
  const verification = lines.slice(2, swap).join('\n')
  expect(verification).toContain('/usr/bin/codesign --verify --deep --strict "$1"')
  expect(verification).toContain('Identifier=app.jefi.mail')
  expect(verification).toContain('TeamIdentifier=6DQ243QTY2')
  expect(verification).toContain('/usr/sbin/spctl --assess --type execute "$1"')
  expect(verification).toContain('/usr/bin/defaults read "$1/Contents/Info" CFBundleShortVersionString')
  expect(verification).toContain('[ "$version" = \'0.2.0\' ]')
  expect(verification).toContain('[ -d "$1" ] && [ ! -L "$1" ] || return 1')
  expect(verification).toContain("verify_candidate '/Applications/.Jefi-update.app' || fail_before_swap")
  expect(swap).toBeGreaterThan(2)
  expect(lines[swap - 1]).toBe("[ ! -e '/Applications/.Jefi-previous-123.app' ] && [ ! -L '/Applications/.Jefi-previous-123.app' ] || fail_before_swap")
  const afterSwap = lines.slice(swap + 1).join('\n')
  expect(afterSwap).toContain("/bin/mv '/Applications/.Jefi-update.app' '/Applications/Jefi.app' && verify_candidate '/Applications/Jefi.app'")
  expect(afterSwap).toContain("/bin/rm -rf '/Applications/.Jefi-previous-123.app'")
  expect(afterSwap).toContain("/bin/mv '/Applications/Jefi.app' '/Applications/.Jefi-update-failed-123.app' || exit 1")
  expect(afterSwap).toContain("/bin/mv '/Applications/.Jefi-previous-123.app' '/Applications/Jefi.app' || exit 1")
  expect(afterSwap).toContain("/usr/bin/open '/Applications/Jefi.app'")
  expect(script).toContain("/bin/mv '/Applications/.Jefi-update.app' '/Applications/.Jefi-update-failed-123.app'")
  // A path with a quote in it can't break out of its quoting.
  expect(swapScript({ pid: 1, app: "/Users/o'neil/Jefi.app", staged: "/Users/o'neil/.stage.app", backup: "/Users/o'neil/.backup.app", failed: "/Users/o'neil/.failed.app", expectedVersion: '0.2.0' })).toContain(`'/Users/o'\\''neil/Jefi.app'`)
  // A pre-existing/colliding backup path can never turn mv into a recursive move.
  expect(() => swapScript({ pid: 1, app: '/Applications/Jefi.app', staged: '/Applications/.Jefi-update.app', backup: '/Applications/Jefi.app', failed: '/Applications/.failed.app', expectedVersion: '0.2.0' })).toThrow('distinct absolute siblings')
})

test('a build from source never looks for updates', async () => {
  let fetched = false
  const h = harness({ official: false, fetchManifest: async () => ((fetched = true), manifest()) })
  expect(h.updater.state()).toEqual({ status: 'unofficial' })
  expect(await h.updater.check()).toEqual({ status: 'unofficial' })
  expect(h.updater.applyStagedAtLaunch()).toBe(false)
  expect(fetched).toBe(false)
  expect(h.log).toEqual([])
})
