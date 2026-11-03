import type { MailThread } from './data'

/** Equal when both are the same, or objects/arrays whose own keys hold the same values. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * Structural equality for plain data (what engine snapshots carry): objects, arrays and primitives.
 * A key holding `undefined` is the same as no key, as in JSON: a patch like `{ draft: undefined }`
 * leaves a conversation equal to the engine's copy of it, which has no such key.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, i) => deepEqual(item, (b as unknown[])[i]))
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  let defined = 0
  for (const k of Object.keys(x)) {
    if (x[k] === undefined) continue
    defined++
    if (!Object.prototype.hasOwnProperty.call(y, k) || !deepEqual(x[k], y[k])) return false
  }
  for (const k of Object.keys(y)) if (y[k] !== undefined) defined--
  return defined === 0
}

/** The same items in the same order, by identity. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

/**
 * Engine publishes rebuild every conversation, changed or not. Handing back the object already on
 * screen when nothing in it changed lets memoized rows skip the publish instead of all re-rendering.
 */
export function reuseUnchanged(upserts: MailThread[], current: MailThread[]): MailThread[] {
  if (!current.length) return upserts
  const byId = new Map(current.map((t) => [t.id, t]))
  return upserts.map((thread) => {
    const before = byId.get(thread.id)
    return before && deepEqual(before, thread) ? before : thread
  })
}

/**
 * List snapshots carry previews, not bodies. When one arrives for a conversation that's already been
 * opened, keep the bodies and attachments loaded for its messages instead of wiping them. A message
 * whose send state is unchanged stays the same object, so the conversation can too (reuseUnchanged).
 */
export function keepLoadedBodies(upserts: MailThread[], current: MailThread[]): MailThread[] {
  const opened = new Map(current.filter((t) => t.full).map((t) => [t.id, t]))
  if (!opened.size) return upserts
  return upserts.map((thread) => {
    const before = opened.get(thread.id)
    if (!before || thread.full) return thread
    const loaded = new Map(before.messages.map((m) => [m.id, m]))
    // A message that's new since opening has no body here; the thread is reloaded when it's reopened.
    const messages = thread.messages.map((m) => {
      const kept = loaded.get(m.id)
      if (!kept) return m
      return kept.status === m.status ? kept : { ...kept, status: m.status }
    })
    return { ...thread, messages, full: messages.every((m) => loaded.has(m.id)) }
  })
}

/**
 * A refetched list with the items already on screen handed back where nothing in them changed
 * (matched by `key`, else `id`), and the old list itself when no item changed. Local queries
 * (notes, tasks, events) refetch everything on each save; this lets memoized rows skip what's the
 * same. Anything that isn't a list is kept when deep-equal.
 */
export function reuseUnchangedItems<T>(prev: T | null, next: T): T {
  if (prev === null) return next
  if (!Array.isArray(prev) || !Array.isArray(next)) return deepEqual(prev, next) ? prev : next
  const keyOf = (item: unknown): unknown => (item && typeof item === 'object' ? ((item as { key?: unknown }).key ?? (item as { id?: unknown }).id) : undefined)
  const before = new Map<unknown, unknown>()
  for (const item of prev) {
    const key = keyOf(item)
    if (key !== undefined) before.set(key, item)
  }
  let same = prev.length === next.length
  const out = next.map((item, i) => {
    const old = before.get(keyOf(item))
    const kept = old !== undefined && deepEqual(old, item) ? old : item
    if (kept !== prev[i]) same = false
    return kept
  })
  return (same ? prev : out) as T
}
