import { beforeEach, describe, expect, test } from 'bun:test'
import { WEB_RISK_THREAT_TYPES, WebRiskError, checkWebRiskUrl, clearWebRiskCache, type WebRiskFetch } from './web-risk'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(clearWebRiskCache)

describe('Google Web Risk lookup', () => {
  test('sends one full URL with all threat lists and keeps the API key out of the request URL', async () => {
    let requestUrl = ''
    let requestHeaders = new Headers()
    let requestRedirect: RequestRedirect | undefined
    const fetcher: WebRiskFetch = async (input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      requestRedirect = init.redirect
      return json({ threat: { threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING'], expireTime: '2030-01-02T03:04:05Z' } })
    }

    const verdict = await checkWebRiskUrl('https://example.com/reset?token=private#step', 'secret-key', { fetcher })
    const request = new URL(requestUrl)
    expect(request.searchParams.get('uri')).toBe('https://example.com/reset?token=private#step')
    expect(request.searchParams.getAll('threatTypes')).toEqual([...WEB_RISK_THREAT_TYPES])
    expect(request.searchParams.has('key')).toBe(false)
    expect(requestHeaders.get('X-Goog-Api-Key')).toBe('secret-key')
    expect(requestRedirect).toBe('error')
    expect(verdict).toEqual({
      kind: 'threat',
      threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING'],
      expiresAt: Date.parse('2030-01-02T03:04:05Z'),
      source: 'google',
    })
  })

  test('does not cache a no-match response without a documented negative expiry', async () => {
    let calls = 0
    const fetcher: WebRiskFetch = async () => {
      calls += 1
      return json({})
    }
    const now = () => 1_000

    expect(await checkWebRiskUrl('https://example.com/', 'key', { fetcher, now })).toEqual({ kind: 'no-match', checkedAt: 1_000, source: 'google' })
    await checkWebRiskUrl('https://example.com/', 'key', { fetcher, now })
    expect(calls).toBe(2)
  })

  test('caches a known threat only until its expiry', async () => {
    let calls = 0
    let time = 1_000
    const fetcher: WebRiskFetch = async () => {
      calls += 1
      return json({ threat: { threatTypes: ['UNWANTED_SOFTWARE'], expireTime: new Date(time + 4_000).toISOString() } })
    }
    const options = { fetcher, now: () => time }

    await checkWebRiskUrl('https://bad.example/', 'key', options)
    await checkWebRiskUrl('https://bad.example/', 'key', options)
    expect(calls).toBe(1)
    time = 5_001
    await checkWebRiskUrl('https://bad.example/', 'key', options)
    expect(calls).toBe(2)
  })

  test('rejects malformed success responses instead of treating them as no match', async () => {
    const fetcher: WebRiskFetch = async () => json({ threat: { threatTypes: ['NEW_UNKNOWN_LIST'], expireTime: 'tomorrow' } })
    const error = await checkWebRiskUrl('https://example.com/', 'key', { fetcher }).catch((caught) => caught)
    expect(error).toBeInstanceOf(WebRiskError)
    expect(error.code).toBe('invalid-response')

    const extraFields: WebRiskFetch = async () => json({ status: 'ok' })
    const extraFieldError = await checkWebRiskUrl('https://example.com/', 'key', { fetcher: extraFields }).catch((caught) => caught)
    expect(extraFieldError.code).toBe('invalid-response')

    const expired: WebRiskFetch = async () => json({ threat: { threatTypes: ['MALWARE'], expireTime: new Date(999).toISOString() } })
    const expiredError = await checkWebRiskUrl('https://expired.example/', 'key', { fetcher: expired, now: () => 1_000 }).catch((caught) => caught)
    expect(expiredError.code).toBe('invalid-response')
  })

  test('turns auth failures into a redacted error', async () => {
    const key = 'secret-key-that-must-not-leak'
    const fetcher: WebRiskFetch = async () => new Response(`Credential ${key} is invalid`, { status: 403 })
    const error = await checkWebRiskUrl('https://example.com/', key, { fetcher }).catch((caught) => caught)
    expect(error).toBeInstanceOf(WebRiskError)
    expect(error.code).toBe('auth')
    expect(error.message).not.toContain(key)
  })

  test('times out a stalled request and aborts the fetch', async () => {
    let aborted = false
    const fetcher: WebRiskFetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
    const error = await checkWebRiskUrl('https://example.com/', 'key', { fetcher, timeoutMs: 5 }).catch((caught) => caught)
    expect(error).toBeInstanceOf(WebRiskError)
    expect(error.code).toBe('timeout')
    expect(aborted).toBe(true)

    const slowJson: WebRiskFetch = async (_input, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
    }) as Response
    const parseTimeout = await checkWebRiskUrl('https://slow-json.example/', 'key', { fetcher: slowJson, timeoutMs: 5 }).catch((caught) => caught)
    expect(parseTimeout.code).toBe('timeout')
  })

  test('honors a caller abort so stale checks can be discarded', async () => {
    const controller = new AbortController()
    const fetcher: WebRiskFetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
    const pending = checkWebRiskUrl('https://example.com/', 'key', { fetcher, signal: controller.signal })
    controller.abort()
    const error = await pending.catch((caught) => caught)
    expect(error).toBeInstanceOf(WebRiskError)
    expect(error.code).toBe('aborted')

    let called = false
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const ignoredAbort: WebRiskFetch = async () => {
      called = true
      return json({})
    }
    const earlyError = await checkWebRiskUrl('https://example.com/', 'key', { fetcher: ignoredAbort, signal: alreadyAborted.signal }).catch((caught) => caught)
    expect(earlyError.code).toBe('aborted')
    expect(called).toBe(false)
  })

  test('rejects non-web links without sending a request', async () => {
    let called = false
    const fetcher: WebRiskFetch = async () => {
      called = true
      return json({})
    }
    const error = await checkWebRiskUrl('mailto:help@example.com', 'key', { fetcher }).catch((caught) => caught)
    expect(error.code).toBe('invalid-url')
    expect(called).toBe(false)
  })
})
