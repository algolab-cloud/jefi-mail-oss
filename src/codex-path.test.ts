import { expect, test } from 'bun:test'
import { findCodex, type CodexProbe } from './codex-path'

/** A pretend Mac: only the listed paths exist and are executable. */
const probe = (options: { executables?: string[]; pathDirs?: string[]; versions?: Record<string, string[]>; shell?: string | null }): CodexProbe => ({
  isExecutable: (path) => (options.executables ?? []).includes(path),
  entries: (path) => options.versions?.[path] ?? [],
  home: '/Users/mara',
  pathDirs: options.pathDirs ?? [],
  fromLoginShell: () => options.shell ?? null,
})

// What launchd gives an app opened from Finder: no Homebrew, no home directory bins.
const GUI_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

test('an app opened from Finder still finds a Homebrew install', () => {
  const found = findCodex(probe({ pathDirs: GUI_PATH, executables: ['/opt/homebrew/bin/codex'] }))
  expect(found).toBe('/opt/homebrew/bin/codex')
})

test('and the home-directory installs the CLI actually uses', () => {
  for (const dir of ['.local/bin', '.bun/bin', '.volta/bin', '.cargo/bin', '.npm-global/bin', '.deno/bin']) {
    const path = `/Users/mara/${dir}/codex`
    expect(findCodex(probe({ pathDirs: GUI_PATH, executables: [path] }))).toBe(path)
  }
})

test('and one installed per Node version, under nvm or fnm', () => {
  const nvm = findCodex(
    probe({
      pathDirs: GUI_PATH,
      versions: { '/Users/mara/.nvm/versions/node': ['v20.11.0', 'v22.20.0'] },
      executables: ['/Users/mara/.nvm/versions/node/v22.20.0/bin/codex'],
    }),
  )
  expect(nvm).toBe('/Users/mara/.nvm/versions/node/v22.20.0/bin/codex')
  const fnm = findCodex(
    probe({ pathDirs: GUI_PATH, versions: { '/Users/mara/.fnm/node-versions': ['v22.0.0'] }, executables: ['/Users/mara/.fnm/node-versions/v22.0.0/installation/bin/codex'] }),
  )
  expect(fnm).toBe('/Users/mara/.fnm/node-versions/v22.0.0/installation/bin/codex')
})

test('$PATH wins when the app was started from a terminal', () => {
  const found = findCodex(probe({ pathDirs: ['/Users/mara/.local/bin', ...GUI_PATH], executables: ['/Users/mara/.local/bin/codex', '/opt/homebrew/bin/codex'] }))
  expect(found).toBe('/Users/mara/.local/bin/codex')
})

test('a path set in Settings beats everything, and is used even where nothing else exists', () => {
  const found = findCodex(probe({ pathDirs: GUI_PATH, executables: ['/opt/homebrew/bin/codex', '/opt/weird/codex'] }), '/opt/weird/codex')
  expect(found).toBe('/opt/weird/codex')
  // Whitespace from a paste doesn't break it.
  expect(findCodex(probe({ executables: ['/opt/weird/codex'] }), '  /opt/weird/codex  ')).toBe('/opt/weird/codex')
})

test('a path set in Settings that is wrong reports nothing found, rather than silently searching on', () => {
  // Otherwise Jefi would quietly use a different binary than the one they chose.
  expect(findCodex(probe({ executables: ['/opt/homebrew/bin/codex'] }), '/gone/codex')).toBeNull()
})

test('JEFI_CODEX_BINARY is honoured, below Settings', () => {
  expect(findCodex(probe({ executables: ['/env/codex'] }), '', '/env/codex')).toBe('/env/codex')
  expect(findCodex(probe({ executables: ['/settings/codex', '/env/codex'] }), '/settings/codex', '/env/codex')).toBe('/settings/codex')
})

test("the login shell is asked last, since it's the slowest and knows the person's own PATH", () => {
  const notAsked = findCodex(probe({ executables: ['/opt/homebrew/bin/codex'], shell: '/never/asked/codex' }))
  expect(notAsked).toBe('/opt/homebrew/bin/codex')
  expect(findCodex(probe({ pathDirs: GUI_PATH, executables: ['/opt/custom/codex'], shell: '/opt/custom/codex' }))).toBe('/opt/custom/codex')
  // A shell that answers with something that isn't there is not trusted.
  expect(findCodex(probe({ shell: '/opt/stale/codex' }))).toBeNull()
})

test('nothing anywhere is null, not a guess', () => {
  expect(findCodex(probe({ pathDirs: GUI_PATH }))).toBeNull()
})
