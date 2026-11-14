import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'

// ---------------------------------------------------------------------------
// One Jefi per mailbox. Two apps on the same mail.db (the installed Jefi and a dev build, say) both
// sync and replay the same queue of changes, and their writes wait on each other until SQLite gives
// up with "database is locked": rules stop half-way, changes stall, the window shows a crash.
//
// So the app takes `app.lock` beside mail.db before it opens any window, and a second one that finds
// it held by a live Jefi brings that one forward and closes. A lock left by a Jefi that crashed (its
// process gone, or the pid now someone else's) is cleared. The CLI and MCP server don't take it:
// they only read, which WAL allows beside the app.
// ---------------------------------------------------------------------------

export type LockHolder = { pid: number; app: string; startedAt: number }
export type LockProbe = {
  /** The process exists. */
  alive: (pid: number) => boolean
  /** The process is a Jefi app (pids get reused: a stale lock mustn't block on some other program). */
  isJefi: (pid: number) => boolean
  /** When the process started (ms since the epoch), or null when that can't be told. */
  started: (pid: number) => number | null
  /** Waits a little before trying again. */
  pause: (ms: number) => void
  now: () => number
}

export type Claim = { ok: true; release: () => void } | { ok: false; holder: LockHolder }

/**
 * How much later than the lock's `startedAt` its process may seem to have started and still be the
 * one that wrote it. The lock is written after the process starts, so its owner started before
 * `startedAt` (ps reports to the second; the slack covers that and small clock steps). A process
 * that started well after it took the pid over once the Jefi that wrote the lock was gone.
 */
export const START_TOLERANCE_MS = 3000
/** A clearing guard older than this was left by a launch that died half-way through clearing. */
const GUARD_STALE_MS = 10_000

const read = (path: string): LockHolder | null => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>
    return typeof value.pid === 'number' && Number.isInteger(value.pid) ? { pid: value.pid, app: String(value.app ?? 'Jefi'), startedAt: Number(value.startedAt) || 0 } : null
  } catch {
    return null
  }
}

const sameHolder = (a: LockHolder | null, b: LockHolder | null) => a === b || (!!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt)

/** The process that wrote this lock still has it: alive, a Jefi app, and not a newer process on a reused pid. */
export function holderIsLive(holder: LockHolder, probe: LockProbe): boolean {
  if (!probe.alive(holder.pid) || !probe.isJefi(holder.pid)) return false
  // A lock without a start time (older builds), or a process whose start ps can't give: assume it's
  // the holder, rather than let two run at once.
  const started = holder.startedAt ? probe.started(holder.pid) : null
  return started === null || started <= holder.startedAt + START_TOLERANCE_MS
}

/**
 * Writes the lock whole beside it, then links it into place: `link` fails when the lock exists, so of
 * two launches only one gets it, and nobody reads a half-written lock. Created afresh (never through
 * a link someone left there) and readable only by this user.
 */
function create(path: string, me: LockHolder): 'ok' | 'exists' | 'failed' {
  const temp = `${path}.${me.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify(me))
    } finally {
      closeSync(fd)
    }
    linkSync(temp, path)
    return 'ok'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed'
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
}

/**
 * Removes the stale lock `judged` (null: unreadable). One launch clears at a time, and only while the
 * lock is still the one it judged: of two launches that found the same stale lock, the slower mustn't
 * delete the lock the faster has just taken. False when another launch is clearing it.
 */
function clearStale(path: string, judged: LockHolder | null): boolean {
  const guard = `${path}.clearing`
  try {
    mkdirSync(guard, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmdirSync(guard)
      } catch {}
    }
    return false
  }
  try {
    if (sameHolder(read(path), judged)) unlinkSync(path)
  } catch {
  } finally {
    try {
      rmdirSync(guard)
    } catch {}
  }
  return true
}

/** One attempt. Anything that stops the lock being taken other than a live Jefi lets the app run. */
export function claimInstance(path: string, me: LockHolder, probe: LockProbe): Claim {
  const release = () => {
    if (!sameHolder(read(path), me)) return
    try {
      unlinkSync(path)
    } catch {}
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const created = create(path, me)
    if (created === 'ok') return { ok: true, release }
    // No folder, no permission: being unable to lock mustn't keep anyone out of their mail.
    if (created === 'failed') return { ok: true, release: () => {} }
    const holder = read(path)
    if (holder && holder.pid !== me.pid && holderIsLive(holder, probe)) return { ok: false, holder }
    // Left by a Jefi that's gone (or unreadable): clear it and take it. Another launch already
    // clearing it: give that a moment, then look again (by then it holds the lock).
    if (!clearStale(path, holder)) probe.pause(50)
  }
  return { ok: true, release: () => {} }
}

/**
 * Claims the lock, waiting up to `waitMs` for a Jefi that holds it to finish quitting (restarting to
 * update, or reopening right after closing). Still held after that: the other Jefi is in use.
 */
export function holdInstance(path: string, me: LockHolder, probe: LockProbe, waitMs = 3000): Claim {
  const until = probe.now() + waitMs
  for (;;) {
    const claim = claimInstance(path, me, probe)
    if (claim.ok || probe.now() >= until) return claim
    probe.pause(250)
  }
}

/**
 * A Jefi app from before this lock existed, running without taking it: found in `ps -axo pid=,command=`
 * output as a bundle's executable launched with no arguments (the CLI and MCP server always have
 * one, `cli` or `mcp`, and only read). Our own process doesn't count.
 */
export function findUnlockedJefi(ps: string, self: number): LockHolder | null {
  for (const line of ps.split('\n')) {
    // The executable is named after its bundle (Jefi.app/…/Jefi), so arguments can't pass for part of it.
    const m = line.trim().match(/^(\d+)\s+(\/.*\/([^/]+)\.app\/Contents\/MacOS\/\3)(\s+-psn_\S+)?$/)
    if (!m || Number(m[1]) === self || !/jefi/i.test(m[3]!)) continue
    return { pid: Number(m[1]), app: bundleOf(m[2]!)!, startedAt: 0 }
  }
  return null
}

/** The .app a Jefi runs from (for its name and to bring it forward), or null when run from a terminal. */
export const bundleOf = (executable: string) => executable.match(/^(.*?\.app)\//)?.[1] ?? null

/** "Jefi Dev", "Jefi", or a plain description when it isn't a bundle. */
export const appLabel = (holder: Pick<LockHolder, 'app'>) => bundleOf(`${holder.app}/`)?.split('/').pop()?.replace(/\.app$/, '') ?? 'Jefi'

/**
 * A command line that could be the Jefi app: its bundle, or a dev run of mail.tsx. The CLI and MCP
 * server (`Jefi mcp`, `bun src/mail.tsx cli inbox`) never take the lock, so one of them on a reused
 * pid doesn't keep a stale lock alive.
 */
export const isJefiAppCommand = (command: string) => /jefi|mail\.tsx/i.test(command) && !/\s(?:mcp|cli)(?:\s|$)/.test(command)

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** `ps -o lstart=` in the C locale ("Thu Nov 12 19:02:22 2026", local time) as ms since the epoch. */
export function parseLstart(text: string): number | null {
  const m = text.trim().match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/)
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (!m || month < 0) return null
  const time = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime()
  return Number.isFinite(time) ? time : null
}

// --- This Mac --------------------------------------------------------------------------------

export const realProbe: LockProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM: it exists, it's just not ours to signal.
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  isJefi(pid) {
    try {
      const out = Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'command='], { stdout: 'pipe', stderr: 'ignore' })
      const command = out.stdout.toString().trim()
      // Can't tell: assume it is, rather than let two run at once.
      return !command || isJefiAppCommand(command)
    } catch {
      return true
    }
  },
  started(pid) {
    try {
      const out = Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'lstart='], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, LC_ALL: 'C' } })
      return parseLstart(out.stdout.toString())
    } catch {
      return null
    }
  },
  pause: (ms) => Bun.sleepSync(ms),
  now: () => Date.now(),
}

/**
 * Takes the lock for this app, or says another Jefi has the mailbox (bringing it forward) and returns
 * null, in which case the caller closes. `dir` is the folder mail.db lives in.
 */
export function lockMailbox(dir: string, options: { checkUnlocked?: boolean } = {}): { release: () => void } | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {}
  const me: LockHolder = { pid: process.pid, app: bundleOf(process.execPath) ?? process.execPath, startedAt: Date.now() }
  let claim = holdInstance(`${dir}/app.lock`, me, realProbe)
  // An older Jefi on the same mailbox doesn't take the lock, so it has to be looked for. Only for the
  // usual mail folder: that's the one an older Jefi uses (a JEFI_CONFIG_DIR run, like a test, isn't).
  if (claim.ok && options.checkUnlocked) {
    let older: LockHolder | null = null
    try {
      older = findUnlockedJefi(Bun.spawnSync(['/bin/ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString(), process.pid)
    } catch {}
    if (older) {
      claim.release()
      claim = { ok: false, holder: older }
    }
  }
  if (claim.ok) {
    process.on('exit', claim.release)
    // Killed rather than quit (logout, shutdown, `kill`): exit handlers don't run on a signal, so give
    // the mailbox back here. (A lock left anyway is cleared by the next launch: its process is gone.)
    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
      process.once(signal, () => {
        claim.release()
        process.exit(code)
      })
    }
    return claim
  }
  const other = bundleOf(`${claim.holder.app}/`)
  const name = appLabel(claim.holder)
  try {
    if (other) Bun.spawnSync(['/usr/bin/open', other], { stdout: 'ignore', stderr: 'ignore' })
    const text = `${name} is already open on this Mac and using your mail. Only one Jefi can use it at a time, so this one will close.`
    Bun.spawnSync(['/usr/bin/osascript', '-e', `display alert "Jefi is already open" message ${JSON.stringify(text)} as informational buttons {"OK"} default button "OK" giving up after 20`], { stdout: 'ignore', stderr: 'ignore' })
  } catch {}
  console.error(`jefi: ${name} (pid ${claim.holder.pid}) already has ${dir}; quitting`)
  return null
}
