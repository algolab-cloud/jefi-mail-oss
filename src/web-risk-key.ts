import { useSyncExternalStore } from 'react'
import { clearWebRiskCache } from './web-risk'
import { keychain } from './keychain'

const KEY_SERVICE = 'app.jefi.web-risk'
const KEY_NAME = 'google-api-key'

let key: string | null = null
let loaded = false
let loadError: string | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

export class WebRiskKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebRiskKeyError'
  }
}

const initialization = keychain.get({ service: KEY_SERVICE, name: KEY_NAME })
  .then((saved) => {
    key = saved?.trim() || null
  })
  .catch(() => {
    loadError = "Couldn't read the Google Web Risk key from Keychain."
  })
  .finally(() => {
    loaded = true
    notify()
  })

export const subscribeWebRiskKey = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getWebRiskKey = () => key
export const getWebRiskKeyStatus = () => ({ key, loaded, error: loadError })

export async function saveWebRiskKey(value: string) {
  await initialization
  const clean = value.trim()
  try {
    if (clean) await keychain.set({ service: KEY_SERVICE, name: KEY_NAME, value: clean })
    else await keychain.delete({ service: KEY_SERVICE, name: KEY_NAME })
  } catch {
    throw new WebRiskKeyError(clean ? "Couldn't save the Google Web Risk key to Keychain." : "Couldn't remove the Google Web Risk key from Keychain.")
  }
  key = clean || null
  loaded = true
  loadError = null
  clearWebRiskCache()
  notify()
}

export async function removeWebRiskKey() {
  await saveWebRiskKey('')
}

export function useWebRiskKey() {
  const savedKey = useSyncExternalStore(subscribeWebRiskKey, () => key)
  const ready = useSyncExternalStore(subscribeWebRiskKey, () => loaded)
  const error = useSyncExternalStore(subscribeWebRiskKey, () => loadError)
  return { key: savedKey, loaded: ready, error, configured: !!savedKey }
}
