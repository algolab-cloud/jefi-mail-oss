import type { SyncState } from './engine/types'

// ---------------------------------------------------------------------------
// What an empty conversation list should say. "Nothing here yet" is only true when Jefi has actually
// looked: before the first sync, mid-sync, offline or after a failure, saying it would be a lie.
// ---------------------------------------------------------------------------

export type EmptyState = {
  title: string
  detail?: string
  /** Shown as the one thing worth doing about it. */
  action?: 'retry' | 'clear'
  /** Whether the first sync is still running, so the list can show a spinner. */
  busy?: boolean
}

export function listEmptyState(state: {
  /** The person narrowed the list themselves (search, filters, a tab). */
  filtered: boolean
  offline: boolean
  sync: Pick<SyncState, 'status' | 'phase' | 'error' | 'lastSyncedAt'>
  /** False before the account's first sync has ever finished. */
  synced: boolean
  /**
   * The view's own query (store `viewPage`): mail in a folder or under a label can be far older
   * than anything the account's list window holds, so only this query knows the view is empty.
   */
  view?: { name: string; loading: boolean; hasMore: boolean }
}): EmptyState {
  // Their own search wins: they know the mailbox isn't empty, they want to know nothing matched.
  if (state.filtered) return { title: 'No conversations match', action: 'clear' }
  // Nothing has come back for this view yet, so there is nothing to say about it.
  if (state.view?.loading) return { title: `Looking in ${state.view.name}…`, busy: true }
  // It came back short but more is stored: the list offers to load it, and this must not say empty.
  if (state.view?.hasMore) return { title: `More of ${state.view.name} hasn’t loaded yet`, detail: 'Load older mail to keep going' }
  if (state.offline) {
    return state.synced
      ? { title: 'Nothing here yet', detail: "You're offline, so this is what's already on this Mac" }
      : { title: "You're offline", detail: 'Jefi will fetch your mail when the connection is back' }
  }
  if (state.sync.status === 'syncing') {
    return { title: state.synced ? 'Checking for new mail…' : 'Fetching your mail…', detail: state.sync.phase ? `${state.sync.phase}…` : undefined, busy: true }
  }
  if (state.sync.status === 'error') {
    return { title: "Couldn't reach your mail", detail: state.sync.error, action: 'retry' }
  }
  // Idle and never synced: the account was only just added, or a sync is due.
  if (!state.synced) return { title: 'No mail yet', detail: 'Jefi hasn’t finished its first sync', action: 'retry' }
  return { title: 'Nothing here yet' }
}
