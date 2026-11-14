import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import { APP_VERSION } from './version'
import { configDir } from './paths'

// ---------------------------------------------------------------------------
// Updates. The release pipeline publishes latest.json (version, DMG url, sha256); Jefi checks it at
// launch and every few hours, downloads a newer build in the background, and swaps itself on the
// next restart — asked for with a toast, or silently at the next launch.
//
// An updater is a remote-code-execution channel, so nothing is installed on the manifest's word
// alone: the DMG must match the published hash, AND the app inside must be signed by Jefi's own
// Developer ID team and pass Gatekeeper (notarized). A swapped download, or a bucket someone else
// can write to, fails the signature check no matter what the manifest says.
//
// Only official builds update. A copy built from source (signed ad hoc, or by someone else's team)
// never asks jefi.app for anything: an official release must not replace a build someone made.
// ---------------------------------------------------------------------------

/** Jefi's Apple Developer team. Only apps signed by it are ever installed. */
export const TEAM_ID = '6DQ243QTY2'
export const BUNDLE_ID = 'app.jefi.mail'
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export type Manifest = { version: string; url: string; sha256: string; published?: string; minimumSystemVersion?: string }

/** -1, 0 or 1 for a < b, a = b, a > b. Plain x.y.z; anything after a dash (pre-release) is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** A manifest worth acting on, or null: well-formed, https, from Jefi's own download host. */
export function parseManifest(value: unknown, allowedHosts = ['downloads.jefi.app']): Manifest | null {
  if (!value || typeof value !== 'object') return null
  const m = value as Record<string, unknown>
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) return null
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return null
  if (typeof m.url !== 'string') return null
  try {
    const url = new URL(m.url)
    if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname)) return null
  } catch {
    return null
  }
  return {
    version: m.version,
    url: m.url,
    sha256: m.sha256.toLowerCase(),
    published: typeof m.published === 'string' ? m.published : undefined,
    minimumSystemVersion: typeof m.minimumSystemVersion === 'string' ? m.minimumSystemVersion : undefined,
  }
}

/**
 * Where this copy of Jefi is installed, if it's somewhere an update can be applied. Null when running
 * from source, or from a quarantined download macOS is running out of a read-only translocated path.
 */
export function installedBundle(execPath = process.execPath): string | null {
  const match = execPath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)
  // The development bundle (scripts/dev.ts) runs from source; an update must never replace it.
  if (!match || execPath.includes('/AppTranslocation/') || match[1]!.endsWith('/Jefi Dev.app')) return null
  return match[1]!
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** `codesign -dv` output names the signer's team; an update must come from ours. */
export function signedByTeam(codesignOutput: string, teamId = TEAM_ID): boolean {
  return new RegExp(`^TeamIdentifier=${teamId}$`, 'm').test(codesignOutput)
}

/** Exact application identity: another app from the team is not a Jefi update. */
export function signedAsJefi(codesignOutput: string, teamId = TEAM_ID, bundleId = BUNDLE_ID): boolean {
  return signedByTeam(codesignOutput, teamId) && new RegExp(`^Identifier=${bundleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(codesignOutput)
}

/**
 * The script that finishes the job once Jefi has quit: swap the bundles, put the old one back if
 * the swap fails half-way, open the new one. Runs detached, so it outlives the app it replaces.
 */
export function swapScript(paths: { pid: number; app: string; staged: string; backup: string; failed: string; expectedVersion: string }): string {
  const locations = [paths.app, paths.staged, paths.backup, paths.failed]
  if (locations.some((path) => !isAbsolute(path)) || new Set(locations).size !== locations.length || locations.some((path) => dirname(path) !== dirname(paths.app))) {
    throw new Error('Update paths must be distinct absolute siblings')
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return [
    '#!/bin/sh',
    `while /bin/kill -0 ${paths.pid} 2>/dev/null; do /bin/sleep 0.2; done`,
    'quarantine_staged() {',
    `  if [ -e ${q(paths.staged)} ] || [ -L ${q(paths.staged)} ]; then /bin/mv ${q(paths.staged)} ${q(paths.failed)}; fi`,
    '}',
    `fail_before_swap() { quarantine_staged || exit 1; /usr/bin/open ${q(paths.app)}; exit 1; }`,
    'verify_candidate() {',
    '  [ -d "$1" ] && [ ! -L "$1" ] || return 1',
    '  /usr/bin/codesign --verify --deep --strict "$1" || return 1',
    '  identity=$(/usr/bin/codesign -dv --verbose=4 "$1" 2>&1) || return 1',
    `  /usr/bin/printf '%s\\n' "$identity" | /usr/bin/grep -Fqx ${q(`Identifier=${BUNDLE_ID}`)} || return 1`,
    `  /usr/bin/printf '%s\\n' "$identity" | /usr/bin/grep -Fqx ${q(`TeamIdentifier=${TEAM_ID}`)} || return 1`,
    '  /usr/sbin/spctl --assess --type execute "$1" || return 1',
    '  version=$(/usr/bin/defaults read "$1/Contents/Info" CFBundleShortVersionString) || return 1',
    `  [ "$version" = ${q(paths.expectedVersion)} ]`,
    '}',
    `[ ! -e ${q(paths.failed)} ] && [ ! -L ${q(paths.failed)} ] || exit 1`,
    `verify_candidate ${q(paths.staged)} || fail_before_swap`,
    `[ ! -e ${q(paths.backup)} ] && [ ! -L ${q(paths.backup)} ] || fail_before_swap`,
    `/bin/mv ${q(paths.app)} ${q(paths.backup)} || fail_before_swap`,
    `if /bin/mv ${q(paths.staged)} ${q(paths.app)} && verify_candidate ${q(paths.app)}; then`,
    `  /bin/rm -rf ${q(paths.backup)}`,
    'else',
    `  if [ -e ${q(paths.app)} ] || [ -L ${q(paths.app)} ]; then`,
    `    /bin/mv ${q(paths.app)} ${q(paths.failed)} || exit 1`,
    `  elif [ -e ${q(paths.staged)} ] || [ -L ${q(paths.staged)} ]; then`,
    `    /bin/mv ${q(paths.staged)} ${q(paths.failed)} || exit 1`,
    '  fi',
    `  /bin/mv ${q(paths.backup)} ${q(paths.app)} || exit 1`,
    'fi',
    `/usr/bin/open ${q(paths.app)}`,
    '',
  ].join('\n')
}

// --- The machinery ---------------------------------------------------------------------------

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: number }
  | { status: 'downloading'; version: string }
  /** Downloaded, verified and staged beside the app: a restart installs it. */
  | { status: 'ready'; version: string }
  /** A newer version exists but this copy can't replace itself (run from source, or not yet moved to Applications). */
  | { status: 'manual'; version: string; url: string }
  | { status: 'error'; message: string }
  /** Built from source rather than released by Jefi: it never looks for updates. */
  | { status: 'unofficial' }

export type UpdaterDeps = {
  currentVersion: string
  /** Whether this copy is a Jefi release (signed by Jefi's team as Jefi); nothing is fetched otherwise. */
  official: boolean
  bundle: string | null
  fetchManifest: () => Promise<unknown>
  download: (url: string) => Promise<Uint8Array>
  /** Mounts the DMG, checks the app inside (signature, team, Gatekeeper) and copies it to `staged`. Throws if anything is off. */
  verifyAndStage: (dmg: Uint8Array, staged: string, expectedVersion: string) => Promise<void>
  /** Version of a fully signature/team/id/Gatekeeper-verified staged app, or null. */
  stagedVersion: (staged: string) => string | null
  /** Hands over to the swap script and quits. */
  restartInto: (staged: string, expectedVersion: string) => void
}

export const stagedPath = (bundle: string) => `${bundle.slice(0, bundle.lastIndexOf('/'))}/.Jefi-update.app`

export function createUpdater(deps: UpdaterDeps, onChange: (state: UpdateState) => void = () => {}) {
  let state: UpdateState = deps.official ? { status: 'idle' } : { status: 'unofficial' }
  const set = (next: UpdateState) => {
    state = next
    onChange(next)
    return next
  }

  return {
    state: () => state,

    /** At launch: an update staged by the last run goes in now, before anything else is on screen. */
    applyStagedAtLaunch(): boolean {
      if (!deps.official || !deps.bundle) return false
      const staged = stagedPath(deps.bundle)
      const version = deps.stagedVersion(staged)
      if (!version || compareVersions(version, deps.currentVersion) <= 0) return false
      deps.restartInto(staged, version)
      return true
    },

    /** One pass: look, and if there's something newer, fetch, verify and stage it. Never throws. */
    async check(): Promise<UpdateState> {
      if (!deps.official) return state
      if (state.status === 'checking' || state.status === 'downloading') return state
      set({ status: 'checking' })
      try {
        const manifest = parseManifest(await deps.fetchManifest())
        if (!manifest || compareVersions(manifest.version, deps.currentVersion) <= 0) return set({ status: 'current', checkedAt: Date.now() })
        if (!deps.bundle) return set({ status: 'manual', version: manifest.version, url: manifest.url })

        const staged = stagedPath(deps.bundle)
        // Already fetched on an earlier pass: don't download 40 MB again.
        if (deps.stagedVersion(staged) === manifest.version) return set({ status: 'ready', version: manifest.version })

        set({ status: 'downloading', version: manifest.version })
        const dmg = await deps.download(manifest.url)
        if (sha256Hex(dmg) !== manifest.sha256) throw new Error("The download didn't match its published checksum")
        await deps.verifyAndStage(dmg, staged, manifest.version)
        return set({ status: 'ready', version: manifest.version })
      } catch (err) {
        return set({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },

    /** Installs the staged update: quits, swaps, reopens. */
    restartToUpdate() {
      if (state.status !== 'ready' || !deps.bundle) return false
      const staged = stagedPath(deps.bundle)
      if (deps.stagedVersion(staged) !== state.version) {
        set({ status: 'error', message: 'The staged update could not be verified. Check for updates again.' })
        return false
      }
      deps.restartInto(staged, state.version)
      return true
    },
  }
}

export type Updater = ReturnType<typeof createUpdater>

// --- This Mac --------------------------------------------------------------------------------

const sh = (command: string, args: string[]) => {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${output.trim().split('\n').pop() ?? result.exitCode}`)
  return output
}

/** Version from a bundle's Info.plist, or null if there's no readable app there. */
function bundleVersion(app: string): string | null {
  try {
    return sh('/usr/bin/defaults', ['read', `${app}/Contents/Info`, 'CFBundleShortVersionString']).trim() || null
  } catch {
    return null
  }
}

function codeIdentity(path: string) {
  return sh('/usr/bin/codesign', ['-dv', '--verbose=4', path])
}

/** Whether the running app is a Jefi release: signed by Jefi's team as Jefi. Wherever it runs from, translocated included. */
export function isOfficialBuild(execPath = process.execPath): boolean {
  const app = execPath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1]
  if (!app) return false
  try {
    return signedAsJefi(codeIdentity(app))
  } catch {
    return false
  }
}

/** Throws unless this is the exact signed, notarized Jefi app and returns its version. */
function verifiedBundleVersion(app: string, expectedVersion?: string): string {
  sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  if (!signedAsJefi(codeIdentity(app))) throw new Error("The update isn't signed as Jefi")
  sh('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
  const version = bundleVersion(app)
  if (!version || (expectedVersion !== undefined && version !== expectedVersion)) {
    throw new Error("The update version doesn't match its manifest")
  }
  return version
}

export async function verifyAndStage(dmg: Uint8Array, staged: string, expectedVersion: string) {
  const fs = require('node:fs') as typeof import('node:fs')
  const work = fs.mkdtempSync(`${require('node:os').tmpdir()}/jefi-update-`)
  const image = `${work}/Jefi.dmg`
  const mount = `${work}/mount`
  fs.writeFileSync(image, dmg)
  fs.mkdirSync(mount)
  try {
    // Reject an untrusted image before asking macOS to parse and mount its filesystem.
    sh('/usr/bin/codesign', ['--verify', '--strict', image])
    if (!signedByTeam(codeIdentity(image))) throw new Error("The update image isn't signed by Jefi")
    sh('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', image])
    sh('/usr/bin/hdiutil', ['attach', image, '-nobrowse', '-readonly', '-mountpoint', mount])
    try {
      const app = `${mount}/Jefi.app`
      verifiedBundleVersion(app, expectedVersion)
      fs.rmSync(staged, { recursive: true, force: true })
      sh('/usr/bin/ditto', [app, staged])
      // The copy is what gets installed: repeat every check after copying.
      verifiedBundleVersion(staged, expectedVersion)
    } finally {
      try {
        sh('/usr/bin/hdiutil', ['detach', mount, '-force'])
      } catch {}
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function restartInto(bundle: string, staged: string, expectedVersion: string) {
  const fs = require('node:fs') as typeof import('node:fs')
  const dir = configDir() ?? require('node:os').tmpdir()
  const script = `${dir}/apply-update.sh`
  const bundleDir = dirname(bundle)
  const swapId = randomUUID()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(script, swapScript({
    pid: process.pid,
    app: bundle,
    staged,
    backup: `${bundleDir}/.Jefi-previous-${swapId}.app`,
    failed: `${bundleDir}/.Jefi-update-failed-${swapId}.app`,
    expectedVersion,
  }), { mode: 0o700 })
  Bun.spawn(['/bin/sh', script], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref()
  process.exit(0)
}

let shared: Updater | null = null
/** The app's updater. `onChange` of the first caller wins; use-updater.ts is that caller. */
export function appUpdater(onChange?: (state: UpdateState) => void): Updater {
  const bundle = installedBundle()
  shared ??= createUpdater(
    {
      currentVersion: APP_VERSION,
      official: isOfficialBuild(),
      bundle,
      fetchManifest: async () => {
        const response = await fetch(`${process.env.JEFI_API_URL ?? 'https://jefi.app'}/api/updates/latest`)
        return response.ok ? response.json() : null
      },
      download: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
      verifyAndStage,
      stagedVersion: (staged) => {
        try { return verifiedBundleVersion(staged) } catch { return null }
      },
      restartInto: (staged, expectedVersion) => bundle && restartInto(bundle, staged, expectedVersion),
    },
    onChange,
  )
  return shared
}
