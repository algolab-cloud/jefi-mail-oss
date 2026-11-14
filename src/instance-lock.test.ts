import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { appLabel, bundleOf, claimInstance, findUnlockedJefi, holdInstance, isJefiAppCommand, parseLstart, START_TOLERANCE_MS, type LockProbe } from './instance-lock'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const lockFile = () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-lock-`)
  dirs.push(dir)
  return `${dir}/app.lock`
}

/**
 * Processes by pid: alive or not, Jefi or something else, and when each started (unknown unless
 * given). A fake clock that `pause` moves on.
 */
const probe = (processes: Record<number, 'jefi' | 'other'>, onPause?: (now: number) => void, starts: Record<number, number> = {}): LockProbe => {
  let clock = 0
  return {
    alive: (pid) => pid in processes,
    isJefi: (pid) => processes[pid] === 'jefi',
    started: (pid) => starts[pid] ?? null,
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

test('a pid reused after a crash by a process that started later does not keep the lock alive', () => {
  const crashedAt = 1_700_000_000_000
  const stale = { pid: 200, app: '/Applications/Jefi.app', startedAt: crashedAt }
  // Pid 200 now belongs to something whose command mentions jefi (an editor in the repo, say),
  // started a minute after the lock was written.
  const path = lockFile()
  writeFileSync(path, JSON.stringify(stale))
  expect(claimInstance(path, me, probe({ 100: 'jefi', 200: 'jefi' }, undefined, { 200: crashedAt + 60_000 })).ok).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(100)

  // The Jefi that wrote it started before it did (or within ps's rounding): still in use.
  for (const started of [crashedAt - 5_000, crashedAt + START_TOLERANCE_MS]) {
    const held = lockFile()
    writeFileSync(held, JSON.stringify(stale))
    expect(claimInstance(held, me, probe({ 100: 'jefi', 200: 'jefi' }, undefined, { 200: started }))).toEqual({ ok: false, holder: stale })
  }
  // No start time to compare (an older lock, or ps can't tell): assume it's the holder.
  const unknown = lockFile()
  writeFileSync(unknown, JSON.stringify(stale))
  expect(claimInstance(unknown, me, probe({ 100: 'jefi', 200: 'jefi' })).ok).toBe(false)
})

test('the CLI and MCP server are not the app, whatever pid they reuse', () => {
  expect(isJefiAppCommand('/Applications/Jefi.app/Contents/MacOS/Jefi')).toBe(true)
  expect(isJefiAppCommand('/Users/x/jefi/build/dev/Jefi Dev.app/Contents/MacOS/Jefi Dev --hot src/mail.tsx')).toBe(true)
  expect(isJefiAppCommand('/Users/x/.bun/bin/bun src/mail.tsx')).toBe(true)
  expect(isJefiAppCommand('/Applications/Jefi.app/Contents/MacOS/Jefi mcp')).toBe(false)
  expect(isJefiAppCommand('/Users/x/.bun/bin/bun /Users/x/jefi/src/mail.tsx mcp')).toBe(false)
  expect(isJefiAppCommand('/Applications/Jefi.app/Contents/MacOS/Jefi cli inbox --json')).toBe(false)
  expect(isJefiAppCommand('/usr/bin/vim notes.txt')).toBe(false)
})

test('process start times from ps are read in local time', () => {
  expect(parseLstart('Thu Nov 12 19:02:22 2026    \n')).toBe(new Date(2026, 10, 12, 19, 2, 22).getTime())
  expect(parseLstart('Mon Jan  5 07:04:09 2026')).toBe(new Date(2026, 0, 5, 7, 4, 9).getTime())
  expect(parseLstart('')).toBeNull()
  expect(parseLstart('jeu 12 nov 19:02:22 2026')).toBeNull()
})

test('of two launches that find the same stale lock, only one takes it', () => {
  const path = lockFile()
  writeFileSync(path, JSON.stringify(other))
  const second = { pid: 300, app: '/Applications/Jefi.app', startedAt: 5 }
  let secondClaim: ReturnType<typeof claimInstance> | undefined
  // The first launch reads the stale lock and checks its pid; meanwhile the second clears it and
  // takes the mailbox. The first must not then delete the second's lock and take it too.
  const first = claimInstance(path, me, {
    ...probe({ 100: 'jefi', 300: 'jefi' }, undefined, { 300: 4 }),
    alive: (pid) => {
      if (pid === 200 && !secondClaim) secondClaim = claimInstance(path, second, probe({ 100: 'jefi', 300: 'jefi' }))
      return pid === 100 || pid === 300
    },
  })
  expect(secondClaim?.ok).toBe(true)
  expect(first).toEqual({ ok: false, holder: second })
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(300)
})

test('many launches at once against a stale lock: exactly one wins', async () => {
  const script = `
    import { claimInstance } from ${JSON.stringify(`${import.meta.dir}/instance-lock.ts`)}
    const [path, startAt] = process.argv.slice(-2)
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
    while (Date.now() < Number(startAt)) {}
    const claim = claimInstance(path, { pid: process.pid, app: 'Jefi', startedAt: Date.now() }, {
      alive, isJefi: () => true, started: () => null, pause: (ms) => Bun.sleepSync(ms), now: () => Date.now(),
    })
    console.log(claim.ok ? 'won' : 'lost')
    // Stay open while the others look, as the app would.
    Bun.sleepSync(1500)
  `
  for (let round = 0; round < 3; round++) {
    const path = lockFile()
    // Left by a Jefi that crashed: no process has this pid.
    writeFileSync(path, JSON.stringify({ pid: 4_194_303, app: 'Jefi', startedAt: 1 }))
    const startAt = Date.now() + 700
    const runs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, '-e', script, path, String(startAt)], { stdout: 'pipe', stderr: 'inherit' }))
    const results = await Promise.all(runs.map(async (run) => (await new Response(run.stdout).text()).trim()))
    expect(results.filter((r) => r === 'won')).toHaveLength(1)
    expect(results.filter((r) => r === 'lost')).toHaveLength(5)
  }
}, 20_000)
