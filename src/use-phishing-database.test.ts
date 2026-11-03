import { describe, expect, test } from 'bun:test'
import type { PhishingDatabase, PhishingDatabaseStatus } from './phishing-database'
import { createPhishingDatabaseLifecycle } from './use-phishing-database'

const STATUS: PhishingDatabaseStatus = Object.freeze({
  loading: false,
  updating: false,
  updatedAt: 1,
  nextUpdateAt: 2,
  stale: false,
  domainCount: 1,
  urlCount: 1,
  source: 'github-snapshot',
  lastError: null,
})

function fakeDatabase(calls: { updates: number; closes: number; listeners: number }): PhishingDatabase {
  return {
    status: () => STATUS,
    subscribe: () => {
      calls.listeners++
      return () => { calls.listeners-- }
    },
    check: (url) => ({ hit: url.includes('blocked'), type: null, source: null, matched: null, updatedAt: 1, stale: false }),
    update: async () => {
      calls.updates++
      return { updated: true, skipped: false, error: null, status: STATUS }
    },
    close: () => { calls.closes++ },
  }
}

describe('optional phishing database lifecycle', () => {
  test('read-only operations never construct or load the database', () => {
    let creates = 0
    const lifecycle = createPhishingDatabaseLifecycle(() => {
      creates++
      return fakeDatabase({ updates: 0, closes: 0, listeners: 0 })
    })

    expect(lifecycle.snapshot()).toBeNull()
    expect(lifecycle.check('https://blocked.example')).toBeNull()
    expect(lifecycle.update()).toBeUndefined()
    expect(creates).toBe(0)
  })

  test('keeps parsed data between enabled readers and closes it only when disabled', () => {
    let creates = 0
    let stops = 0
    const calls = { updates: 0, closes: 0, listeners: 0 }
    const lifecycle = createPhishingDatabaseLifecycle(
      () => { creates++; return fakeDatabase(calls) },
      () => () => { stops++ },
    )

    const first = lifecycle.subscribe(() => {})
    const second = lifecycle.subscribe(() => {})
    expect({ creates, updates: calls.updates, listeners: calls.listeners }).toEqual({ creates: 1, updates: 1, listeners: 2 })
    expect(lifecycle.snapshot()).toBe(STATUS)
    expect(lifecycle.check('https://blocked.example')?.hit).toBe(true)

    first()
    expect({ closes: calls.closes, stops, listeners: calls.listeners }).toEqual({ closes: 0, stops: 0, listeners: 1 })
    second()
    second()
    expect({ closes: calls.closes, stops, listeners: calls.listeners }).toEqual({ closes: 0, stops: 1, listeners: 0 })
    expect(lifecycle.snapshot()).toBe(STATUS)

    const reenabled = lifecycle.subscribe(() => {})
    expect({ creates, updates: calls.updates }).toEqual({ creates: 1, updates: 2 })
    reenabled()
    lifecycle.disable()
    expect(calls.closes).toBe(1)
    expect(lifecycle.snapshot()).toBeNull()
  })

  test('disable isolates late cleanup from a newly enabled database', () => {
    let creates = 0
    const calls = { updates: 0, closes: 0, listeners: 0 }
    const lifecycle = createPhishingDatabaseLifecycle(() => {
      creates++
      return fakeDatabase(calls)
    }, () => () => {})

    const oldReader = lifecycle.subscribe(() => {})
    lifecycle.disable()
    const newReader = lifecycle.subscribe(() => {})
    oldReader()
    expect({ creates, closes: calls.closes, listeners: calls.listeners }).toEqual({ creates: 2, closes: 1, listeners: 1 })
    expect(lifecycle.snapshot()).toBe(STATUS)
    newReader()
    lifecycle.disable()
    expect(calls.closes).toBe(2)
  })
})
