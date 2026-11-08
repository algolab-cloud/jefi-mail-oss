import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

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
  /** The process is a Jefi (pids get reused: a stale lock mustn't block on some other program). */
  isJefi: (pid: number) => boolean
  /** Waits a little before trying again. */
  pause: (ms: number) => void
  now: () => number
}

export type Claim = { ok: true; release: () => void } | { ok: false; holder: LockHolder }

const read = (path: string): LockHolder | null => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>
    return typeof value.pid === 'number' && Number.isInteger(value.pid) ? { pid: value.pid, app: String(value.app ?? 'Jefi'), startedAt: Number(value.startedAt) || 0 } : null
  } catch {
    return null
  }
}

/** One attempt. Anything that stops the lock being taken other than a live Jefi lets the app run. */
export function claimInstance(path: string, me: LockHolder, probe: LockProbe): Claim {
  const release = () => {
    if (read(path)?.pid !== me.pid) return
    try {
      unlinkSync(path)
    } catch {}
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      try {
        writeSync(fd, JSON.stringify(me))
      } finally {
        closeSync(fd)
      }
      return { ok: true, release }
    } catch (err) {
      // No folder, no permission: being unable to lock mustn't keep anyone out of their mail.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: true, release: () => {} }
    }
    const holder = read(path)
    if (holder && holder.pid !== me.pid && probe.alive(holder.pid) && probe.isJefi(holder.pid)) return { ok: false, holder }
    // Left by a Jefi that's gone (or unreadable): clear it and take it.
    try {
      unlinkSync(path)
    } catch {}
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
      return !command || /jefi|mail\.tsx/i.test(command)
    } catch {
      return true
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
    mkdirSync(dir, { recursive: true })
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
