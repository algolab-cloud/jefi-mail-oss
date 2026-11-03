import {
  checkPhishingIndex,
  DEFAULT_UPDATE_INTERVAL_MS,
  EMPTY_PHISHING_INDEX,
  type CreatePhishingDatabaseOptions,
  type PhishingDatabase,
  type PhishingDatabaseStatus,
  type PhishingIndex,
  type PhishingUpdateResult,
} from './phishing-database'

export type PhishingWorkerOptions = Omit<CreatePhishingDatabaseOptions, 'fetch' | 'now' | 'onIndex'>

export type PhishingToWorker =
  | { kind: 'init'; options: PhishingWorkerOptions }
  | { kind: 'update'; force: boolean }

export type PhishingFromWorker =
  | { kind: 'status'; status: PhishingDatabaseStatus }
  | ({ kind: 'index' } & PhishingIndex)
  | { kind: 'updated'; result: PhishingUpdateResult }

/**
 * In `bun build --compile` binaries the worker is an extra entrypoint embedded at
 * this absolute $bunfs path; relative specifiers would resolve against the cwd.
 */
const workerEntry = () => (import.meta.url.includes('$bunfs') ? '/$bunfs/root/phishing-worker.js' : new URL('./phishing-worker.ts', import.meta.url).href)

type BunWorker = Worker & { unref?: () => void }

/**
 * A PhishingDatabase whose loading, downloads and parsing run in a Bun Worker.
 * check() stays synchronous against the sorted hash index the worker hands back
 * and reports a miss until that index arrives, so link review never waits on it.
 *
 * The worker only lives for a load or an update: its heap holds the parsed JSON
 * and feed strings, so retiring it leaves just the ~8-byte-per-entry index here.
 */
export function createWorkerPhishingDatabase(options: PhishingWorkerOptions): PhishingDatabase {
  if (!options.directory) throw new Error('A phishing database directory is required.')
  const updateIntervalMs = options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS
  const listeners = new Set<() => void>()
  let worker: BunWorker | null = null
  let workerLoaded = false
  let index: PhishingIndex = EMPTY_PHISHING_INDEX
  let closed = false
  let loadedOnce = false
  let lastAttemptAt: number | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<PhishingUpdateResult> | null = null
  let resolveUpdate: ((result: PhishingUpdateResult) => void) | null = null
  let queuedForce: boolean | null = null
  let resolveLoad: (() => void) | null = null
  const initialLoad = new Promise<void>((resolve) => { resolveLoad = resolve })
  let currentStatus: PhishingDatabaseStatus = Object.freeze({
    loading: true,
    updating: false,
    updatedAt: null,
    nextUpdateAt: null,
    stale: true,
    domainCount: 0,
    urlCount: 0,
    source: null,
    lastError: null,
  })

  const publish = (next: PhishingDatabaseStatus) => {
    currentStatus = Object.freeze(next)
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A UI subscriber must not break database updates or other subscribers.
      }
    }
  }

  // The retired worker can't flip the list to stale, so the client keeps that clock.
  const scheduleStale = () => {
    if (staleTimer) clearTimeout(staleTimer)
    staleTimer = null
    if (closed || currentStatus.updatedAt === null || currentStatus.stale || updateIntervalMs === 0) return
    const remaining = currentStatus.updatedAt + updateIntervalMs - Date.now()
    if (remaining <= 0) return publish({ ...currentStatus, stale: true })
    staleTimer = setTimeout(() => {
      staleTimer = null
      if (!closed) publish({ ...currentStatus, stale: true })
    }, Math.min(remaining, 2_147_483_647))
    staleTimer.unref?.()
  }

  const retire = () => {
    worker?.terminate()
    worker = null
    workerLoaded = false
  }

  const finishUpdate = (result: PhishingUpdateResult) => {
    const resolve = resolveUpdate
    resolveUpdate = null
    retire()
    resolve?.(result)
  }

  const onLoaded = () => {
    workerLoaded = true
    if (!loadedOnce) {
      loadedOnce = true
      lastAttemptAt = currentStatus.updatedAt
      resolveLoad?.()
    }
    if (queuedForce !== null) {
      worker!.postMessage({ kind: 'update', force: queuedForce } satisfies PhishingToWorker)
      queuedForce = null
    } else if (!resolveUpdate) {
      retire()
    }
  }

  const spawn = () => {
    const current = new Worker(workerEntry()) as BunWorker
    worker = current
    workerLoaded = false
    current.onmessage = (event: MessageEvent<PhishingFromWorker>) => {
      if (closed || worker !== current) return
      const message = event.data
      if (message.kind === 'index') {
        // The worker sends the index just before the status that announces it.
        index = Object.freeze({ domains: message.domains, urls: message.urls, source: message.source, revision: message.revision })
      } else if (message.kind === 'status') {
        // A respawned worker starts from "loading"; keep showing the list already in hand.
        if (message.status.loading && loadedOnce) return
        publish(message.status)
        scheduleStale()
        if (!workerLoaded && !message.status.loading) onLoaded()
      } else if (message.kind === 'updated') {
        finishUpdate(message.result)
      }
    }
    current.onerror = (event) => {
      if (closed || worker !== current) return
      const lastError = event.message || 'Phishing database worker failed.'
      publish({ ...currentStatus, loading: false, updating: false, lastError })
      if (!loadedOnce) {
        loadedOnce = true
        resolveLoad?.()
      }
      queuedForce = null
      finishUpdate({ updated: false, skipped: false, error: lastError, status: currentStatus })
    }
    // The worker only serves opted-in views; it must never keep the app alive.
    current.unref?.()
    current.postMessage({ kind: 'init', options } satisfies PhishingToWorker)
  }

  spawn()

  const closedResult = (): PhishingUpdateResult => ({
    updated: false,
    skipped: false,
    error: 'Phishing database is closed.',
    status: currentStatus,
  })

  return {
    status: () => currentStatus,
    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    check: (rawUrl) => checkPhishingIndex(index, currentStatus, rawUrl),
    update(updateOptions = {}) {
      if (closed) return Promise.resolve(closedResult())
      if (inFlight) return inFlight
      const force = Boolean(updateOptions.force)
      inFlight = (async () => {
        await initialLoad
        if (closed) return closedResult()
        // Skip without waking a worker, mirroring the core's own interval check.
        if (!force && lastAttemptAt !== null && Date.now() - lastAttemptAt < updateIntervalMs) {
          return { updated: false, skipped: true, error: null, status: currentStatus }
        }
        const startedAt = Date.now()
        const result = await new Promise<PhishingUpdateResult>((resolve) => {
          resolveUpdate = resolve
          if (!worker) spawn()
          if (workerLoaded) worker!.postMessage({ kind: 'update', force } satisfies PhishingToWorker)
          else queuedForce = force
        })
        if (!result.skipped && !closed) lastAttemptAt = startedAt
        return result
      })().finally(() => {
        inFlight = null
      })
      return inFlight
    },
    close() {
      if (closed) return
      closed = true
      listeners.clear()
      index = EMPTY_PHISHING_INDEX
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = null
      // Terminating drops the worker's sockets and parsed data at once.
      retire()
      resolveLoad?.()
      const resolve = resolveUpdate
      resolveUpdate = null
      resolve?.(closedResult())
    },
  }
}
