import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PhishingDatabase } from './phishing-database'
import { createWorkerPhishingDatabase } from './phishing-worker-client'

const temporaryDirectories: string[] = []
const databases: PhishingDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function directoryWithSnapshot(snapshot?: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jefi-phishing-worker-test-'))
  temporaryDirectories.push(directory)
  if (snapshot) await writeFile(join(directory, 'phishing-database-v1.json'), JSON.stringify(snapshot))
  return directory
}

function open(directory: string): PhishingDatabase {
  const database = createWorkerPhishingDatabase({ directory, updateIntervalMs: 60 * 60 * 1_000 })
  databases.push(database)
  return database
}

function loaded(database: PhishingDatabase): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = database.subscribe(() => {
      if (database.status().loading) return
      unsubscribe()
      resolve()
    })
  })
}

describe('worker phishing database', () => {
  test('loads the stored snapshot off-thread and answers exact lookups synchronously', async () => {
    const database = open(await directoryWithSnapshot({
      version: 2,
      updatedAt: Date.now(),
      source: 'published-checksum',
      revision: null,
      integrity: { algorithm: 'sha256', domains: 'a'.repeat(64), urls: 'b'.repeat(64) },
      domains: ['reported.example'],
      urls: ['https://safe.example/login'],
    }))
    // Before the worker answers, review sees an honest pending miss rather than blocking.
    expect(database.status().loading).toBe(true)
    expect(database.check('https://reported.example/').hit).toBe(false)

    await loaded(database)
    expect(database.status()).toMatchObject({ loading: false, domainCount: 1, urlCount: 1, stale: false, lastError: null })
    expect(database.check('https://REPORTED.example./path')).toMatchObject({ hit: true, type: 'domain', matched: 'reported.example' })
    expect(database.check('https://sub.reported.example/').hit).toBe(false)
    expect(database.check('https://safe.example/login#x')).toMatchObject({ hit: true, type: 'url', matched: 'https://safe.example/login' })
    expect(database.check('https://safe.example/other').hit).toBe(false)
  })

  test('reports invalid stored data without an index', async () => {
    const database = open(await directoryWithSnapshot({ version: 9 }))
    await loaded(database)
    expect(database.status().lastError).toBe('Stored phishing database metadata is invalid.')
    expect(database.check('https://reported.example/').hit).toBe(false)
  })

  test('skips an unforced update inside the interval without waking a worker', async () => {
    const database = open(await directoryWithSnapshot({
      version: 2,
      updatedAt: Date.now(),
      source: 'published-checksum',
      revision: null,
      integrity: { algorithm: 'sha256', domains: 'a'.repeat(64), urls: 'b'.repeat(64) },
      domains: ['reported.example'],
      urls: ['https://safe.example/login'],
    }))
    expect(await database.update()).toMatchObject({ updated: false, skipped: true, error: null })
    expect(database.status()).toMatchObject({ loading: false, domainCount: 1 })
    expect(database.check('https://reported.example/').hit).toBe(true)
  })

  test('close settles pending work and ignores later updates', async () => {
    const database = open(await directoryWithSnapshot())
    await loaded(database)
    database.close()
    expect(await database.update({ force: true })).toMatchObject({ updated: false, error: 'Phishing database is closed.' })
  })
})
