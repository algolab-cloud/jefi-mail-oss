import { expect, test } from 'bun:test'
import { IDLE_SYNC, IDLE_SYNC_META, REVEAL_AFTER_MS, REVEAL_FAIL_AFTER_MS, REVEAL_FAIL_STREAK, nextSyncView, revealBackgroundSync, type SyncMeta } from './sync-view'

const SYNCED: SyncMeta = IDLE_SYNC_META
/** A steady-state account: already synced a while ago, nothing running. */
const idleView = (lastSyncedAt: number) => ({ status: 'idle' as const, done: 1, total: 1, lastSyncedAt })

test('background sync stays hidden: the displayed view does not move to syncing', () => {
  const prevView = idleView(1_000)
  const result = nextSyncView(prevView, { status: 'syncing', phase: 'Connecting', done: 0, total: 1, lastSyncedAt: 1_000 }, SYNCED, false, 2_000)
  expect(result.view).toBe(prevView)
  expect(result.meta.running).toBe(true)
  expect(result.meta.revealed).toBe(false)
  expect(result.reveal).toBe('start')
})

test('a hidden background sync is revealed generically once REVEAL_AFTER_MS has passed', () => {
  const prevView = idleView(1_000)
  const running: SyncMeta = { running: true, revealed: false, failStreak: 0 }
  const { view, meta } = revealBackgroundSync(prevView, { status: 'syncing', phase: 'Sent', done: 1, total: 3, lastSyncedAt: 1_000 }, running)
  expect(view).toEqual({ status: 'syncing', done: 1, total: 3, lastSyncedAt: 1_000, background: true })
  expect(meta.revealed).toBe(true)
  // No folder name leaked into the revealed view.
  expect((view as { phase?: string }).phase).toBeUndefined()

  // Once revealed, later background events for the same run stay generic (no folder names ticking by).
  const next = nextSyncView(view, { status: 'syncing', phase: 'Archive', done: 2, total: 3, lastSyncedAt: 1_000 }, meta, false, 1_000 + REVEAL_AFTER_MS + 10)
  expect(next.view.status).toBe('syncing')
  expect((next.view as { phase?: string }).phase).toBeUndefined()
  expect(next.view.background).toBe(true)
})

test('revealing a background sync that already finished or was already revealed is a no-op', () => {
  const prevView = idleView(1_000)
  expect(revealBackgroundSync(prevView, IDLE_SYNC, SYNCED).view).toBe(prevView)
  const alreadyRevealed: SyncMeta = { running: true, revealed: true, failStreak: 0 }
  expect(revealBackgroundSync(prevView, { status: 'syncing', done: 0, total: 1 }, alreadyRevealed).view).toBe(prevView)
})

test('a manual sync always shows full detail, phase names included', () => {
  const prevView = idleView(1_000)
  const connecting = nextSyncView(prevView, { status: 'syncing', phase: 'Connecting', done: 0, total: 3, lastSyncedAt: 1_000 }, SYNCED, true, 1_000)
  expect(connecting.view).toEqual({ status: 'syncing', phase: 'Connecting', done: 0, total: 3, lastSyncedAt: 1_000, background: false })
  expect(connecting.reveal).toBe('clear')

  const inbox = nextSyncView(connecting.view, { status: 'syncing', phase: 'Inbox', done: 1, total: 3, lastSyncedAt: 1_000 }, connecting.meta, true, 1_500)
  expect(inbox.view.phase).toBe('Inbox')
  expect(inbox.view.background).toBe(false)
})

test('an account that has never synced shows progress in full even though the event is a background one', () => {
  const result = nextSyncView(IDLE_SYNC, { status: 'syncing', phase: 'Inbox', done: 0, total: 2 }, SYNCED, false, 1_000)
  expect(result.view).toEqual({ status: 'syncing', phase: 'Inbox', done: 0, total: 2, background: false })
  expect(result.reveal).toBe('clear')
})

test('a background failure is hidden until the third consecutive attempt', () => {
  const good = idleView(1_000)
  const first = nextSyncView(good, { status: 'error', error: 'timeout', done: 0, total: 1, lastSyncedAt: 1_000 }, SYNCED, false, 2_000)
  expect(first.view).toMatchObject({ status: 'idle', lastSyncedAt: 1_000 }) // still showing the last good state
  expect(first.meta.failStreak).toBe(1)

  const second = nextSyncView(good, { status: 'error', error: 'timeout', done: 0, total: 1, lastSyncedAt: 1_000 }, first.meta, false, 3_000)
  expect(second.view).toMatchObject({ status: 'idle', lastSyncedAt: 1_000 })
  expect(second.meta.failStreak).toBe(2)

  const third = nextSyncView(good, { status: 'error', error: 'timeout', done: 0, total: 1, lastSyncedAt: 1_000 }, second.meta, false, 4_000)
  expect(third.view.status).toBe('error')
  expect(third.view.background).toBe(true)
  expect(third.meta.failStreak).toBe(3)
})

test('a background failure surfaces once the streak drags on past REVEAL_FAIL_AFTER_MS, even under 3 tries', () => {
  const good = idleView(1_000)
  const first = nextSyncView(good, { status: 'error', error: 'timeout', done: 0, total: 1, lastSyncedAt: 1_000 }, SYNCED, false, 1_000)
  expect(first.view.status).toBe('idle')
  const later = nextSyncView(good, { status: 'error', error: 'timeout', done: 0, total: 1, lastSyncedAt: 1_000 }, first.meta, false, 1_000 + REVEAL_FAIL_AFTER_MS + 1)
  expect(later.view.status).toBe('error')
  expect(later.view.background).toBe(true)
})

test('a manual failure shows immediately, streak or no streak', () => {
  const good = idleView(1_000)
  const withStreak: SyncMeta = { running: false, revealed: false, failStreak: REVEAL_FAIL_STREAK - 1, failingSince: 500 }
  const result = nextSyncView(good, { status: 'error', error: 'no route to host', done: 0, total: 1, lastSyncedAt: 1_000 }, withStreak, true, 2_000)
  expect(result.view.status).toBe('error')
  expect(result.view.background).toBe(false)
  expect(result.meta.failStreak).toBe(0)
})

test('a successful sync resets the failure streak and clears the background flag', () => {
  const good = idleView(1_000)
  const failing: SyncMeta = { running: false, revealed: false, failStreak: 2, failingSince: 1_000 }
  const result = nextSyncView(good, { status: 'idle', done: 1, total: 1, lastSyncedAt: 9_000 }, failing, false, 9_000)
  expect(result.view).toEqual({ status: 'idle', done: 1, total: 1, lastSyncedAt: 9_000, background: false })
  expect(result.meta).toEqual(IDLE_SYNC_META)
  expect(result.reveal).toBe('clear')
})

test('syncNow reveals an already-running background sync immediately, ahead of the timer', () => {
  const prevView = idleView(1_000)
  const running: SyncMeta = { running: true, revealed: false, failStreak: 0 }
  const raw = { status: 'syncing' as const, phase: 'Sent', done: 1, total: 4, lastSyncedAt: 1_000 }
  const { view, meta } = revealBackgroundSync(prevView, raw, running)
  expect(view.status).toBe('syncing')
  expect(view.background).toBe(true)
  expect(meta.revealed).toBe(true)
})


test('a hidden failure after a revealed run goes back to idle instead of staying on "Updating…"', () => {
  const raw = { status: 'syncing' as const, done: 0, total: 1, lastSyncedAt: 1_000 }
  const started = nextSyncView(idleView(1_000), raw, SYNCED, false, 2_000)
  const revealed = revealBackgroundSync(started.view, raw, started.meta)
  expect(revealed.view.background).toBe(true)
  const failed = nextSyncView(revealed.view, { ...raw, status: 'error', error: 'timeout' }, revealed.meta, false, 7_000)
  expect(failed.view).toMatchObject({ status: 'idle', lastSyncedAt: 1_000, background: false })
})
