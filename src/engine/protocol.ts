import type { EngineEvent, MailEngine } from './types'

// ---------------------------------------------------------------------------
// Messages between the UI thread (WorkerEngine) and the engine worker. Commands are the
// MailEngine methods by name; the worker answers each with a result and pushes events in batches.
// ---------------------------------------------------------------------------

export type EngineMethod = Exclude<keyof MailEngine, 'subscribe' | 'dispose'>

export type ToWorker = { kind: 'command'; id: number; method: EngineMethod; args: unknown[] }

export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'events'; events: EngineEvent[] }
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: string }
