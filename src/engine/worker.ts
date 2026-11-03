// Engine worker entry: hosts a MailEngine off the UI thread and speaks the protocol in ./protocol.
import { createAppEngine } from './compose'
import type { EngineEvent } from './types'
import type { FromWorker, ToWorker } from './protocol'

declare const self: Worker

const engine = createAppEngine()
const post = (message: FromWorker) => self.postMessage(message)

// Coalesce event bursts into one message per tick, so the UI applies them in a single render.
let pending: EngineEvent[] = []
engine.subscribe((events) => {
  if (!pending.length) queueMicrotask(flush)
  pending.push(...events)
})
function flush() {
  const events = pending
  pending = []
  if (events.length) post({ kind: 'events', events })
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const { id, method, args } = event.data
  try {
    const value = await (engine[method] as (...a: unknown[]) => unknown)(...args)
    post({ kind: 'result', id, ok: true, value: value ?? null })
  } catch (err) {
    post({ kind: 'result', id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

post({ kind: 'ready' })
