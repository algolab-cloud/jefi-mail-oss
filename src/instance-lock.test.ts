import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { appLabel, bundleOf, claimInstance, findUnlockedJefi, holdInstance, type LockProbe } from './instance-lock'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const lockFile = () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-lock-`)
  dirs.push(dir)
  return `${dir}/app.lock`
}

/** Processes by pid: alive or not, Jefi or something else. A fake clock that `pause` moves on. */
const probe = (processes: Record<number, 'jefi' | 'other'>, onPause?: (now: number) => void): LockProbe => {
  let clock = 0
  return {
    alive: (pid) => pid in processes,
    isJefi: (pid) => processes[pid] === 'jefi',
    pause: (ms) => {
      clock += ms
      onPause?.(clock)
    },
    now: () => clock,
  }
}
const me = { pid: 100, app: '/Applications/Jefi.app', startedAt: 1 }
const other = { pid: 200, app: '/Users/x/jefi/build/dev/Jefi Dev.app', startedAt: 1 }

test('the first Jefi takes the lock and gives it back when it closes', () => {
  const path = lockFile()
  const claim = claimInstance(path, me, probe({ 100: 'jefi' }))
  expect(claim.ok).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(100)
  if (claim.ok) claim.release()
  expect(existsSync(path)).toBe(false)
})

test('a second Jefi on the same mailbox is turned away, and learns which one has it', () => {
  const path = lockFile()
  writeFileSync(path, JSON.stringify(other))
  const claim = claimInstance(path, me, probe({ 100: 'jefi', 200: 'jefi' }))
  expect(claim).toEqual({ ok: false, holder: other })
  expect(appLabel(claim.ok ? me : claim.holder)).toBe('Jefi Dev')
})

test('a lock left by a Jefi that crashed, or whose pid is now another program, is cleared', () => {
  const crashed = lockFile()
  writeFileSync(crashed, JSON.stringify(other))
  expect(claimInstance(crashed, me, probe({ 100: 'jefi' })).ok).toBe(true)
  expect(JSON.parse(readFileSync(crashed, 'utf8')).pid).toBe(100)

  const reused = lockFile()
  writeFileSync(reused, JSON.stringify(other))
  expect(claimInstance(reused, me, probe({ 100: 'jefi', 200: 'other' })).ok).toBe(true)

  const garbled = lockFile()
  writeFileSync(garbled, 'not json')
  expect(claimInstance(garbled, me, probe({ 100: 'jefi' })).ok).toBe(true)
})

test('releasing never removes a lock another Jefi has taken since', () => {
  const path = lockFile()
  const claim = claimInstance(path, me, probe({ 100: 'jefi' }))
  writeFileSync(path, JSON.stringify(other))
  if (claim.ok) claim.release()
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(200)
})

test('reopening while the old Jefi is still quitting (restart to update) waits for it', () => {
  const path = lockFile()
  writeFileSync(path, JSON.stringify(other))
  const processes: Record<number, 'jefi' | 'other'> = { 100: 'jefi', 200: 'jefi' }
  // The old one exits two seconds in.
  const claim = holdInstance(path, me, probe(processes, (now) => now >= 2000 && delete processes[200]))
  expect(claim.ok).toBe(true)
  // One that stays open is still in use after the wait.
  writeFileSync(path, JSON.stringify(other))
  expect(holdInstance(path, { ...me, pid: 300 }, probe({ 200: 'jefi', 300: 'jefi' }), 1000).ok).toBe(false)
})

test('a folder the lock cannot be written in never keeps anyone out', () => {
  expect(claimInstance('/nonexistent-dir-for-jefi/app.lock', me, probe({ 100: 'jefi' })).ok).toBe(true)
})

test('the app is named after its bundle', () => {
  expect(bundleOf('/Applications/Jefi.app/Contents/MacOS/Jefi')).toBe('/Applications/Jefi.app')
  expect(bundleOf('/Users/x/.bun/bin/bun')).toBeNull()
  expect(appLabel({ app: '/Applications/Jefi.app' })).toBe('Jefi')
  expect(appLabel({ app: '/Users/x/.bun/bin/bun' })).toBe('Jefi')
})

test('an older Jefi that never takes the lock is still found, but its CLI and MCP server are not', () => {
  const ps = [
    '  412 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '56573 /Applications/Jefi.app/Contents/MacOS/Jefi',
    '56590 /Applications/Jefi.app/Contents/MacOS/Jefi mcp',
    '  777 /Users/x/jefi/build/dev/Jefi Dev.app/Contents/MacOS/Jefi Dev --hot src/mail.tsx',
  ].join('\n')
  expect(findUnlockedJefi(ps, 777)).toEqual({ pid: 56573, app: '/Applications/Jefi.app', startedAt: 0 })
  // Ourselves, a headless run, and other apps don't count.
  expect(findUnlockedJefi('56573 /Applications/Jefi.app/Contents/MacOS/Jefi', 56573)).toBeNull()
  expect(findUnlockedJefi('56590 /Applications/Jefi.app/Contents/MacOS/Jefi cli inbox', 1)).toBeNull()
  expect(findUnlockedJefi('412 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', 1)).toBeNull()
  // An old-style launch argument from Finder is still a GUI launch.
  expect(findUnlockedJefi('9 /Applications/Jefi.app/Contents/MacOS/Jefi -psn_0_12345', 1)?.pid).toBe(9)
})
