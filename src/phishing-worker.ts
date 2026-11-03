/// <reference lib="webworker" />
import { createPhishingDatabase, type PhishingDatabase, type PhishingIndex } from './phishing-database'
import type { PhishingFromWorker, PhishingToWorker } from './phishing-worker-client'

// Loading, verifying, parsing and hashing the list costs seconds and hundreds of
// MiB of transient strings; doing it here keeps the UI thread responsive. The UI
// only receives status and the compact hash index.
declare const self: Worker
let database: PhishingDatabase | null = null

const post = (message: PhishingFromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer)

const sendIndex = (index: PhishingIndex) => {
  // Copies are cheap (8 bytes per entry) and keep the worker's own index usable.
  const domains = index.domains.slice()
  const urls = index.urls.slice()
  post({ kind: 'index', domains, urls, source: index.source, revision: index.revision }, [domains.buffer, urls.buffer])
  // The parsed JSON and feed strings are garbage now; return that memory promptly
  // instead of leaving hundreds of MiB for a lazy collection in an idle worker.
  setTimeout(() => Bun.gc(true), 0)
}

self.onmessage = (event: MessageEvent<PhishingToWorker>) => {
  const message = event.data
  if (message.kind === 'init') {
    if (database) return
    const current = createPhishingDatabase({ ...message.options, onIndex: sendIndex })
    database = current
    current.subscribe(() => post({ kind: 'status', status: current.status() }))
    post({ kind: 'status', status: current.status() })
  } else if (message.kind === 'update') {
    if (!database) return
    void database.update({ force: message.force }).then((result) => post({ kind: 'updated', result }))
  }
}
