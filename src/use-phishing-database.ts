import { useSyncExternalStore } from 'react'
import { join } from 'node:path'
import { configDir } from './paths'
import { createWorkerPhishingDatabase } from './phishing-worker-client'
import { type PhishingCheckResult, type PhishingDatabase, type PhishingDatabaseStatus } from './phishing-database'

const REFRESH_INTERVAL_MS = 60 * 60 * 1_000
type Repeat = (callback: () => void, intervalMs: number) => () => void

const repeat: Repeat = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Retains opted-in parsed data and refreshes it while enabled views are subscribed. */
export function createPhishingDatabaseLifecycle(
  create: () => PhishingDatabase | null,
  schedule: Repeat = repeat,
) {
  type Session = { database: PhishingDatabase; readers: number; stopRefresh: (() => void) | null }
  let active: Session | null = null

  const pause = (session: Session) => {
    session.stopRefresh?.()
    session.stopRefresh = null
  }

  const subscribe = (listener: () => void) => {
    let session = active
    if (!session) {
      const database = create()
      if (!database) return () => {}
      session = { database, readers: 0, stopRefresh: null }
      active = session
    }
    session.readers++
    const unsubscribe = session.database.subscribe(listener)
    if (session.readers === 1) {
      // Download public lists only: no message, sender, or clicked URL leaves the Mac.
      void session.database.update()
      session.stopRefresh = schedule(() => { void session.database.update() }, REFRESH_INTERVAL_MS)
    }
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      unsubscribe()
      session.readers--
      if (session.readers === 0) pause(session)
    }
  }

  const disable = () => {
    const session = active
    if (!session) return
    active = null
    pause(session)
    session.database.close()
  }

  return {
    subscribe,
    disable,
    snapshot: (): PhishingDatabaseStatus | null => active?.database.status() ?? null,
    check: (url: string): PhishingCheckResult | null => active?.database.check(url) ?? null,
    update: () => active?.database.update({ force: true }),
  }
}

const lifecycle = createPhishingDatabaseLifecycle(() => {
  const directory = configDir()
  return directory ? createWorkerPhishingDatabase({ directory: join(directory, 'link-protection') }) : null
})
const disabledSubscribe = () => () => {}
const disabledSnapshot = () => null
const disabledCheck = () => null
const disabledUpdate = () => undefined

/** Settings calls this before persisting off, so cached data and in-flight requests stop at once. */
export const disablePhishingDatabase = () => lifecycle.disable()

/** Keep the public feed current only while an opted-in link review or Settings row is in use. */
export function usePhishingDatabase(enabled = false) {
  const status = useSyncExternalStore(enabled ? lifecycle.subscribe : disabledSubscribe, enabled ? lifecycle.snapshot : disabledSnapshot)
  return {
    status: enabled ? status : null,
    check: enabled ? lifecycle.check : disabledCheck,
    update: enabled ? lifecycle.update : disabledUpdate,
  }
}
