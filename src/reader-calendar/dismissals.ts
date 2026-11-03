import { useSyncExternalStore } from 'react'
import { configDir } from '../paths'

// Messages whose date suggestions the person waved away. Kept on this Mac only, in its own small
// file beside settings.json (it's history, not a preference), and capped so it never grows unbounded.

const LIMIT = 1000
const FILE = 'date-suggestions.json'

let dismissed: string[] | null = null
const listeners = new Set<() => void>()

function load(): string[] {
  if (dismissed) return dismissed
  dismissed = []
  const dir = configDir()
  if (!dir) return dismissed
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(`${dir}/${FILE}`, 'utf8')) as { dismissed?: unknown }
    if (Array.isArray(raw.dismissed)) dismissed = raw.dismissed.filter((id): id is string => typeof id === 'string').slice(-LIMIT)
  } catch {
    // Missing or unreadable: nothing dismissed yet.
  }
  return dismissed
}

function save(list: string[]) {
  const dir = configDir()
  if (!dir) return
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(`${dir}/${FILE}`, `${JSON.stringify({ dismissed: list })}\n`)
  } catch {
    // Not worth a toast: at worst the strip comes back next launch.
  }
}

/** The Message-ID header survives resyncs and re-threading; the UI id is the fallback. */
export const dismissalKey = (message: { id: string; messageId?: string }) => message.messageId || message.id

export const isDismissed = (key: string) => load().includes(key)

export function dismiss(key: string) {
  const list = load()
  if (list.includes(key)) return
  dismissed = [...list, key].slice(-LIMIT)
  save(dismissed)
  for (const listener of listeners) listener()
}

/** For tests: forget what was loaded so the next read goes to disk again. */
export function resetDismissals() {
  dismissed = null
}

export function useDismissed(key: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => isDismissed(key),
  )
}
