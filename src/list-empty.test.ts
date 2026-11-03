import { expect, test } from 'bun:test'
import { listEmptyState } from './list-empty'

const idle = { status: 'idle' as const, phase: undefined, error: undefined, lastSyncedAt: 1 }
const never = { status: 'idle' as const, phase: undefined, error: undefined, lastSyncedAt: undefined }
const base = { filtered: false, offline: false, sync: idle, synced: true }

test('a mailbox Jefi has actually looked in is the only one called empty', () => {
  expect(listEmptyState(base)).toEqual({ title: 'Nothing here yet' })
})

test('before the first sync it does not claim the mailbox is empty', () => {
  const state = listEmptyState({ ...base, sync: never, synced: false })
  expect(state.title).toBe('No mail yet')
  expect(state.action).toBe('retry')
})

test('mid-sync it says so, and offers a spinner rather than an action', () => {
  const first = listEmptyState({ ...base, synced: false, sync: { ...never, status: 'syncing', phase: 'Inbox' } })
  expect(first).toMatchObject({ title: 'Fetching your mail…', detail: 'Inbox…', busy: true })
  expect(first.action).toBeUndefined()
  // A later sync is a check, not a first download.
  expect(listEmptyState({ ...base, sync: { ...idle, status: 'syncing' } }).title).toBe('Checking for new mail…')
})

test('offline explains itself, and says what is on the Mac when there is history', () => {
  expect(listEmptyState({ ...base, offline: true })).toMatchObject({ title: 'Nothing here yet', detail: "You're offline, so this is what's already on this Mac" })
  expect(listEmptyState({ ...base, offline: true, synced: false, sync: never }).title).toBe("You're offline")
  // Offline is not a failure to retry: there's nothing to retry against.
  expect(listEmptyState({ ...base, offline: true }).action).toBeUndefined()
})

test('a failed sync shows the reason and a way to try again', () => {
  const state = listEmptyState({ ...base, sync: { ...idle, status: 'error', error: "Couldn't reach imap.fastmail.com" } })
  expect(state).toMatchObject({ title: "Couldn't reach your mail", detail: "Couldn't reach imap.fastmail.com", action: 'retry' })
})

test('a folder is only called empty once its own query has come back with nothing', () => {
  const view = { name: 'Receipts', loading: false, hasMore: false }
  // Still looking: an old folder holds mail far outside the account's list window.
  expect(listEmptyState({ ...base, view: { ...view, loading: true } })).toEqual({ title: 'Looking in Receipts…', busy: true })
  // It came back short of what's stored, so "nothing here" would be false.
  expect(listEmptyState({ ...base, view: { ...view, hasMore: true } })).toMatchObject({ title: 'More of Receipts hasn’t loaded yet' })
  expect(listEmptyState({ ...base, view: { ...view, hasMore: true } }).busy).toBeUndefined()
  // Asked, answered, and there is genuinely nothing.
  expect(listEmptyState({ ...base, view })).toEqual({ title: 'Nothing here yet' })
  // A sync still running is the older reason, and it still wins over an answered view query.
  expect(listEmptyState({ ...base, view, synced: false, sync: { ...never, status: 'syncing' } }).busy).toBe(true)
})

test('their own search or filter wins over any sync state', () => {
  for (const sync of [idle, never, { ...idle, status: 'error' as const }, { ...idle, status: 'syncing' as const }]) {
    for (const offline of [true, false]) {
      expect(listEmptyState({ filtered: true, offline, sync, synced: false })).toEqual({ title: 'No conversations match', action: 'clear' })
    }
  }
})
