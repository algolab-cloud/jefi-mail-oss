import { useEffect, useSyncExternalStore } from 'react'
import { CHECK_EVERY_MS, appUpdater, type UpdateState } from './updater'

// The updater as React state: one shared status, checked at launch and every few hours.

let state: UpdateState | null = null
const listeners = new Set<() => void>()
const updater = () =>
  appUpdater((next) => {
    state = next
    for (const listener of listeners) listener()
  })

export const checkForUpdates = () => updater().check()
export const restartToUpdate = () => updater().restartToUpdate()

let watching = false
/** Starts the background checks. `enabled` is the Settings switch; a manual check works either way. */
export function watchForUpdates(enabled: boolean) {
  if (watching || !enabled || updater().state().status === 'unofficial') return
  watching = true
  // A build staged by the last run is installed before anything else happens.
  if (updater().applyStagedAtLaunch()) return
  void checkForUpdates()
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)
}

export function useUpdater(): UpdateState {
  useEffect(() => void updater(), [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (state ??= updater().state()),
  )
}
