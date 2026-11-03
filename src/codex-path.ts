import { accessSync, constants, readdirSync } from 'node:fs'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// Finding the Codex CLI.
//
// An app opened from Finder inherits almost nothing: launchd hands it
// /usr/bin:/bin:/usr/sbin:/sbin, while `codex` installs into a home directory or Homebrew. Looking
// it up by name alone works from a terminal and fails for everyone else, which is what "Executable
// not found in $PATH" meant.
//
// So: the path from Settings, else JEFI_CODEX_BINARY, else the usual install locations, else
// whatever the person's own login shell would find. The answer is cached until Settings change.
// ---------------------------------------------------------------------------

/** Where `codex` installs itself, relative to the home directory. */
const HOME_DIRS = ['.local/bin', '.bun/bin', '.volta/bin', '.deno/bin', '.cargo/bin', '.npm-global/bin', 'node_modules/.bin', '.codex/bin']
/** And the machine-wide ones, Apple silicon Homebrew first. */
const SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']

export type CodexProbe = {
  /** True when the path is a file this process may execute. */
  isExecutable: (path: string) => boolean
  /** Directories inside one directory, for version-per-directory installs like nvm. */
  entries: (path: string) => string[]
  home: string
  /** $PATH as the process actually has it, which for a bundled app is next to nothing. */
  pathDirs: string[]
  /** What the person's login shell would resolve, asked only when nothing else worked. */
  fromLoginShell?: () => string | null
}

/**
 * The first `codex` that exists, or null. `configured` (Settings) and `env` win over any search, so
 * an unusual install can always be pointed at by hand.
 */
export function findCodex(probe: CodexProbe, configured?: string, env?: string): string | null {
  for (const chosen of [configured?.trim(), env?.trim()]) {
    if (chosen) return probe.isExecutable(chosen) ? chosen : null
  }
  const candidates = [
    ...probe.pathDirs.map((dir) => `${dir}/codex`),
    ...HOME_DIRS.map((dir) => `${probe.home}/${dir}/codex`),
    ...SYSTEM_DIRS.map((dir) => `${dir}/codex`),
    // nvm keeps a bin directory per Node version; a global install lands in whichever was current.
    ...nodeVersionDirs(probe).map((dir) => `${dir}/codex`),
  ]
  for (const candidate of candidates) {
    if (probe.isExecutable(candidate)) return candidate
  }
  // Last resort: the login shell knows the PATH the person actually set up.
  const fromShell = probe.fromLoginShell?.()
  return fromShell && probe.isExecutable(fromShell) ? fromShell : null
}

function nodeVersionDirs(probe: CodexProbe): string[] {
  const roots = [`${probe.home}/.nvm/versions/node`, `${probe.home}/.fnm/node-versions`, `${probe.home}/Library/Application Support/fnm/node-versions`]
  return roots.flatMap((root) => probe.entries(root).flatMap((version) => [`${root}/${version}/bin`, `${root}/${version}/installation/bin`]))
}

/** What to tell someone when it isn't anywhere we looked. */
export const CODEX_MISSING =
  'Jefi couldn’t find the Codex CLI. Install it, or set its path in Settings → AI (run `which codex` in Terminal to see where it is).'

// --- This Mac --------------------------------------------------------------------------------

const realProbe: CodexProbe = {
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  entries(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  home: homedir(),
  pathDirs: (process.env.PATH ?? '').split(':').filter(Boolean),
  fromLoginShell() {
    try {
      const shell = process.env.SHELL || '/bin/zsh'
      // -lic so the shell reads the profile that sets PATH, exactly as a terminal would.
      const result = Bun.spawnSync([shell, '-lic', 'command -v codex'], { stdout: 'pipe', stderr: 'ignore' })
      const found = result.stdout.toString().trim().split('\n').pop()?.trim()
      return found && found.startsWith('/') ? found : null
    } catch {
      return null
    }
  },
}

let configuredPath = ''
let cached: string | null | undefined

/** Settings tell us where it is; changing that forgets what we last found. */
export function setCodexPath(path: string) {
  const next = path.trim()
  if (next === configuredPath) return
  configuredPath = next
  cached = undefined
}

/** The Codex CLI on this Mac, or null. Cached: the search touches the disk and may ask the shell. */
export function codexPath(): string | null {
  if (cached === undefined) cached = findCodex(realProbe, configuredPath, process.env.JEFI_CODEX_BINARY)
  return cached
}

/** Forgets the cached location, so a fresh install is picked up without a restart. */
export const forgetCodexPath = () => void (cached = undefined)

/** The command to spawn. Falls back to the bare name so the caller still gets a "not found" error. */
export const codexBinary = () => codexPath() ?? 'codex'
