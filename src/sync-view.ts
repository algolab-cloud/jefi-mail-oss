import type { SyncState } from './engine/types'

// ---------------------------------------------------------------------------
// What sync activity is worth showing. The engine syncs constantly in the background (every 60s, on
// IDLE push, after local actions), which would make the sidebar spin and flash red all day if every
// event reached the screen. Apple Mail, Mimestream and Delta Chat all show *state*, not *activity*:
// a background sync stays invisible unless it drags on, and a lone background failure stays invisible
// unless it keeps happening. Manual syncs (the person clicked something) and an account's very first
// sync are always shown in full, folder names and all, because someone is actually watching those.
// ---------------------------------------------------------------------------

/** `SyncState` plus a UI-only flag: true when this is a background sync/failure that got revealed,
 *  so the caller can render it generically ("Updating…") instead of ticking through folder names. */
export type SyncView = SyncState & { background?: boolean }

export type SyncMeta = {
  /** A background sync is currently in flight for this account (revealed or not). */
  running: boolean
  /** The current background run has been surfaced (past REVEAL_AFTER_MS, or a manual check nudged it). */
  revealed: boolean
  /** Consecutive background failures; any success or manual attempt resets it. */
  failStreak: number
  /** When the current failing streak started, so a long-running outage surfaces even under 3 tries. */
  failingSince?: number
}

export const IDLE_SYNC: SyncState = { status: 'idle', done: 0, total: 1 }
export const IDLE_SYNC_META: SyncMeta = { running: false, revealed: false, failStreak: 0 }

/** A hidden background sync becomes visible (generically) once it's run this long. */
export const REVEAL_AFTER_MS = 4_000
/** Hide a background failure until it's failed this many times in a row... */
export const REVEAL_FAIL_STREAK = 3
/** ...or until the failing streak has dragged on this long, whichever comes first. */
export const REVEAL_FAIL_AFTER_MS = 2 * 60_000
/** How long "Up to date" stands in for the ticking "Synced Ns ago". */
export const FRESH_MS = 3 * 60_000

export type SyncViewResult = {
  view: SyncView
  meta: SyncMeta
  /** Tell the caller to (re)start the REVEAL_AFTER_MS timer, cancel a pending one, or leave it alone. */
  reveal: 'start' | 'clear' | 'none'
}

/**
 * Folds one syncState event into what should be displayed. `raw` is the account's latest full engine
 * state (the caller merges each event's partial into it — events only ever carry what changed).
 * `prevView` is what's on screen now; `meta` is the caller-owned bookkeeping this function updates.
 */
export function nextSyncView(prevView: SyncView, raw: SyncState, meta: SyncMeta, manual: boolean, now: number): SyncViewResult {
  // Never synced means this is the account's first download: show it in full so the empty mailbox
  // doesn't look broken while it fills in.
  const neverSynced = raw.lastSyncedAt === undefined
  const show = manual || neverSynced

  if (raw.status === 'idle') {
    // A finished sync is always safe to surface — no folders ticking, nothing alarming — and it's
    // the point where a failing streak (if any) is forgiven.
    return { view: { ...raw, background: false }, meta: { ...IDLE_SYNC_META }, reveal: 'clear' }
  }

  if (raw.status === 'syncing') {
    if (show) return { view: { ...raw, background: false }, meta: { ...meta, running: false, revealed: false }, reveal: 'clear' }
    if (!meta.running) {
      // A background sync just started: stay on whatever was shown before, and ask the caller to
      // start the reveal timer. Later events for this same run land here again with running=true,
      // so the timer isn't restarted every time the engine moves to the next folder.
      return { view: prevView, meta: { ...meta, running: true, revealed: false }, reveal: 'start' }
    }
    if (meta.revealed) {
      // Revealed, but still generic: no folder name, so it doesn't look like it's racing through the
      // mailbox — just "something's happening".
      return { view: { status: 'syncing', done: raw.done, total: raw.total, lastSyncedAt: raw.lastSyncedAt, background: true }, meta, reveal: 'none' }
    }
    return { view: prevView, meta, reveal: 'none' }
  }

  // raw.status === 'error'
  if (show) return { view: { ...raw, background: false }, meta: { ...IDLE_SYNC_META }, reveal: 'clear' }
  const failingSince = meta.failingSince ?? now
  const failStreak = meta.failStreak + 1
  const nextMeta: SyncMeta = { running: false, revealed: false, failStreak, failingSince }
  const overdue = failStreak >= REVEAL_FAIL_STREAK || now - failingSince > REVEAL_FAIL_AFTER_MS
  if (overdue) return { view: { ...raw, background: true }, meta: nextMeta, reveal: 'clear' }
  // Hidden: back to the last good state (idle + its lastSyncedAt). Not `prevView`: a revealed run shows
  // "Updating…", which would otherwise stay on screen until the next sync.
  return { view: { ...IDLE_SYNC, lastSyncedAt: raw.lastSyncedAt, background: false }, meta: nextMeta, reveal: 'clear' }
}

/**
 * REVEAL_AFTER_MS has passed on a hidden background sync, or the person asked to sync while one was
 * already running (their manual sync gets queued behind it, so there's nothing new to show yet — but
 * the fact that something's happening shouldn't stay hidden once they've asked). A no-op once the run
 * has already finished or already been revealed.
 */
export function revealBackgroundSync(prevView: SyncView, raw: SyncState, meta: SyncMeta): { view: SyncView; meta: SyncMeta } {
  if (!meta.running || meta.revealed) return { view: prevView, meta }
  return {
    view: { status: 'syncing', done: raw.done, total: raw.total, lastSyncedAt: raw.lastSyncedAt, background: true },
    meta: { ...meta, revealed: true },
  }
}
