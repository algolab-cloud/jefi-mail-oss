const LOOKUP_ENDPOINT = 'https://webrisk.googleapis.com/v1/uris:search'
const KEY_CHECK_URL = 'https://example.com/'
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_CACHE_ENTRIES = 256
const MAX_POSITIVE_CACHE_MS = 24 * 60 * 60 * 1_000

export const WEB_RISK_THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'] as const
export type WebRiskThreatType = (typeof WEB_RISK_THREAT_TYPES)[number]

export type WebRiskVerdict =
  | { kind: 'threat'; threatTypes: WebRiskThreatType[]; expiresAt: number; source: 'google' }
  | { kind: 'no-match'; checkedAt: number; source: 'google' }

export type WebRiskErrorCode = 'invalid-url' | 'missing-key' | 'auth' | 'quota' | 'timeout' | 'aborted' | 'unavailable' | 'invalid-response'

export class WebRiskError extends Error {
  constructor(readonly code: WebRiskErrorCode, message: string) {
    super(message)
    this.name = 'WebRiskError'
  }
}

export type WebRiskFetch = (url: URL, init: RequestInit) => Promise<Response>

export type WebRiskLookupOptions = {
  signal?: AbortSignal
  fetcher?: WebRiskFetch
  now?: () => number
  timeoutMs?: number
  bypassCache?: boolean
}

type CachedThreat = { verdict: Extract<WebRiskVerdict, { kind: 'threat' }>; cacheUntil: number }
const threatCache = new Map<string, CachedThreat>()

export function clearWebRiskCache() {
  threatCache.clear()
}

const parsedHttpUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebRiskError('invalid-url', 'Only complete HTTP or HTTPS links can be checked with Google Web Risk.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebRiskError('invalid-url', 'Only complete HTTP or HTTPS links can be checked with Google Web Risk.')
  }
  return url
}

const cachedThreat = (url: string, now: number): Extract<WebRiskVerdict, { kind: 'threat' }> | null => {
  const cached = threatCache.get(url)
  if (!cached) return null
  if (cached.cacheUntil <= now) {
    threatCache.delete(url)
    return null
  }
  return cached.verdict
}

const rememberThreat = (url: string, verdict: Extract<WebRiskVerdict, { kind: 'threat' }>, now: number) => {
  const cacheUntil = Math.min(verdict.expiresAt, now + MAX_POSITIVE_CACHE_MS)
  if (cacheUntil <= now) return
  threatCache.delete(url)
  threatCache.set(url, { verdict, cacheUntil })
  while (threatCache.size > MAX_CACHE_ENTRIES) {
    const oldest = threatCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    threatCache.delete(oldest)
  }
}

const responseVerdict = (value: unknown, now: number): WebRiskVerdict => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebRiskError('invalid-response', 'Google Web Risk returned an invalid response.')
  }
  const threat = (value as { threat?: unknown }).threat
  if (threat === undefined) {
    if (Object.keys(value).length) throw new WebRiskError('invalid-response', 'Google Web Risk returned an invalid response.')
    return { kind: 'no-match', checkedAt: now, source: 'google' }
  }
  if (!threat || typeof threat !== 'object' || Array.isArray(threat)) {
    throw new WebRiskError('invalid-response', 'Google Web Risk returned an invalid response.')
  }

  const { threatTypes, expireTime } = threat as { threatTypes?: unknown; expireTime?: unknown }
  const allowed = new Set<string>(WEB_RISK_THREAT_TYPES)
  if (!Array.isArray(threatTypes) || !threatTypes.length || !threatTypes.every((type) => typeof type === 'string' && allowed.has(type)) || typeof expireTime !== 'string') {
    throw new WebRiskError('invalid-response', 'Google Web Risk returned an invalid response.')
  }
  const expiresAt = Date.parse(expireTime)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new WebRiskError('invalid-response', 'Google Web Risk returned an invalid response.')
  return { kind: 'threat', threatTypes: [...new Set(threatTypes as WebRiskThreatType[])], expiresAt, source: 'google' }
}

async function lookupWebRiskUrl(rawUrl: string, apiKey: string, options: WebRiskLookupOptions): Promise<WebRiskVerdict> {
  const key = apiKey.trim()
  if (!key) throw new WebRiskError('missing-key', 'Add a Google Web Risk API key in Settings first.')
  const checkedUrl = parsedHttpUrl(rawUrl).toString()
  if (options.signal?.aborted) throw new WebRiskError('aborted', 'Google Web Risk check cancelled.')
  const now = options.now ?? Date.now
  const startedAt = now()
  if (!options.bypassCache) {
    const cached = cachedThreat(checkedUrl, startedAt)
    if (cached) return cached
  }

  const endpoint = new URL(LOOKUP_ENDPOINT)
  for (const threatType of WEB_RISK_THREAT_TYPES) endpoint.searchParams.append('threatTypes', threatType)
  endpoint.searchParams.set('uri', checkedUrl)

  const controller = new AbortController()
  const callerSignal = options.signal
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const fetcher: WebRiskFetch = options.fetcher ?? ((url, init) => fetch(url, init))
    const response = await fetcher(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Goog-Api-Key': key },
      redirect: 'error',
      signal: controller.signal,
    })
    if (callerSignal?.aborted) throw new WebRiskError('aborted', 'Google Web Risk check cancelled.')
    if (timedOut) throw new WebRiskError('timeout', 'Google Web Risk took too long to respond.')
    if (response.status === 401 || response.status === 403) {
      throw new WebRiskError('auth', 'Google rejected this API key. Check that Web Risk is enabled and the key can use it.')
    }
    if (response.status === 429) throw new WebRiskError('quota', 'Google Web Risk quota reached. Try again later.')
    if (!response.ok) throw new WebRiskError('unavailable', 'Google Web Risk could not complete the check.')

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new WebRiskError('invalid-response', 'Google Web Risk returned an invalid response.')
    }
    if (callerSignal?.aborted) throw new WebRiskError('aborted', 'Google Web Risk check cancelled.')
    if (timedOut) throw new WebRiskError('timeout', 'Google Web Risk took too long to respond.')
    const verdict = responseVerdict(body, now())
    if (!options.bypassCache && verdict.kind === 'threat') rememberThreat(checkedUrl, verdict, now())
    return verdict
  } catch (error) {
    if (callerSignal?.aborted) throw new WebRiskError('aborted', 'Google Web Risk check cancelled.')
    if (timedOut) throw new WebRiskError('timeout', 'Google Web Risk took too long to respond.')
    if (error instanceof WebRiskError) throw error
    throw new WebRiskError('unavailable', "Couldn't reach Google Web Risk. Check your connection.")
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

/** Checks one clicked URL. Call this only after the person explicitly chooses “Check with Google”. */
export const checkWebRiskUrl = (url: string, apiKey: string, options: WebRiskLookupOptions = {}) => lookupWebRiskUrl(url, apiKey, options)

/** Confirms key access with a fixed public URL; no email link is disclosed during setup. */
export async function validateWebRiskKey(apiKey: string, options: WebRiskLookupOptions = {}): Promise<void> {
  await lookupWebRiskUrl(KEY_CHECK_URL, apiKey, { ...options, bypassCache: true })
}
