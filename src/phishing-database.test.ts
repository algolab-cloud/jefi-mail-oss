import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPhishingDatabase, PHISHING_DATABASE_SOURCES } from './phishing-database'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jefi-phishing-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function gitBlobSha(value: string): string {
  const bytes = Buffer.from(value)
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

function feedResponses(domains: string, urls: string): Map<string, string> {
  return new Map([
    [PHISHING_DATABASE_SOURCES.domains.data, domains],
    [PHISHING_DATABASE_SOURCES.domains.checksum, `${sha256(domains)} *phishing-domains-ACTIVE.txt`],
    [PHISHING_DATABASE_SOURCES.urls.data, urls],
    [PHISHING_DATABASE_SOURCES.urls.checksum, `${sha256(urls)} *phishing-links-ACTIVE.txt`],
  ])
}

function githubResponses(domains: string, urls: string, revision = 'a'.repeat(40)): Map<string, string> {
  const treeSha = 'b'.repeat(40)
  const domainSha = gitBlobSha(domains)
  const urlSha = gitBlobSha(urls)
  return new Map([
    [PHISHING_DATABASE_SOURCES.github.commit, JSON.stringify({ sha: revision, commit: { tree: { sha: treeSha } } })],
    [`${PHISHING_DATABASE_SOURCES.github.tree}${treeSha}`, JSON.stringify({
      sha: treeSha,
      truncated: false,
      tree: [
        {
          path: PHISHING_DATABASE_SOURCES.github.domainsPath,
          type: 'blob',
          sha: domainSha,
          size: Buffer.byteLength(domains),
          url: 'https://attacker.invalid/domain-data',
        },
        {
          path: PHISHING_DATABASE_SOURCES.github.urlsPath,
          type: 'blob',
          sha: urlSha,
          size: Buffer.byteLength(urls),
          url: 'https://attacker.invalid/url-data',
        },
      ],
    })],
    [`${PHISHING_DATABASE_SOURCES.github.raw}${revision}/${PHISHING_DATABASE_SOURCES.github.domainsPath}`, domains],
    [`${PHISHING_DATABASE_SOURCES.github.raw}${revision}/${PHISHING_DATABASE_SOURCES.github.urlsPath}`, urls],
  ])
}

function mockFetch(responses: Map<string, string>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    const body = responses.get(url)
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body)
  }) as typeof fetch
}

async function waitUntilLoaded(database: ReturnType<typeof createPhishingDatabase>): Promise<void> {
  for (let attempt = 0; attempt < 100 && database.status().loading; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(database.status().loading).toBe(false)
}

describe('phishing database', () => {
  test('rejects a tree that differs from the pinned commit before fetching threat files', async () => {
    const responses = githubResponses('phish.example\n', 'https://phish.example/login\n')
    const treeUrl = `${PHISHING_DATABASE_SOURCES.github.tree}${'b'.repeat(40)}`
    const tree = JSON.parse(responses.get(treeUrl)!)
    tree.sha = 'c'.repeat(40)
    responses.set(treeUrl, JSON.stringify(tree))
    const calls: string[] = []
    const database = createPhishingDatabase({ directory: await temporaryDirectory(), fetch: mockFetch(responses, calls) })
    expect((await database.update()).updated).toBe(false)
    expect(calls.some((url) => url.startsWith(PHISHING_DATABASE_SOURCES.github.raw))).toBe(false)
    database.close()
  })

  test('closing an in-flight update aborts requests without starting a fallback', async () => {
    const calls: string[] = []
    const database = createPhishingDatabase({
      directory: await temporaryDirectory(),
      fetch: (async (input, init) => {
        calls.push(String(input))
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }) as typeof fetch,
    })
    await waitUntilLoaded(database)
    const updating = database.update()
    await new Promise((resolve) => setTimeout(resolve, 1))
    database.close()
    expect((await updating).updated).toBe(false)
    expect(calls).toHaveLength(4)
    expect(calls).not.toContain(PHISHING_DATABASE_SOURCES.github.commit)
  })

  test('checks exact canonical URLs and exact hosts without visiting the target', async () => {
    const directory = await temporaryDirectory()
    const calls: string[] = []
    const responses = feedResponses(
      'phish.example\nother.phish.example\nlegacy_host.example\n',
      'https://login.example/account?flow=reset\nhttp://plain.example/path\n',
    )
    const database = createPhishingDatabase({
      directory,
      fetch: mockFetch(responses, calls),
      now: () => 100_000,
    })
    let notifications = 0
    const unsubscribe = database.subscribe(() => notifications++)

    const update = await database.update()

    expect(update).toMatchObject({ updated: true, skipped: false, error: null })
    expect(database.status()).toMatchObject({
      loading: false,
      updating: false,
      updatedAt: 100_000,
      stale: false,
      domainCount: 3,
      urlCount: 2,
      lastError: null,
    })
    expect(database.check('https://login.example/account?flow=reset#ignored')).toMatchObject({
      hit: true,
      type: 'url',
      matched: 'https://login.example/account?flow=reset',
      source: PHISHING_DATABASE_SOURCES.urls.data,
    })
    expect(database.check('https://login.example/account?flow=other').hit).toBe(false)
    expect(database.check('https://login.example./account?flow=reset').type).toBe('url')
    expect(database.check('https://phish.example/anything')).toMatchObject({
      hit: true,
      type: 'domain',
      matched: 'phish.example',
      source: PHISHING_DATABASE_SOURCES.domains.data,
    })
    expect(database.check('https://sub.phish.example/').hit).toBe(false)
    expect(database.check('https://legacy_host.example/').type).toBe('domain')
    expect(calls).toHaveLength(4)
    expect(new Set(calls)).toEqual(new Set([
      PHISHING_DATABASE_SOURCES.domains.data,
      PHISHING_DATABASE_SOURCES.domains.checksum,
      PHISHING_DATABASE_SOURCES.urls.data,
      PHISHING_DATABASE_SOURCES.urls.checksum,
    ]))
    expect(notifications).toBeGreaterThanOrEqual(2)
    expect(database.status()).toBe(database.status())

    unsubscribe()
    database.close()
  })

  test('rate-limits automatic updates while allowing a forced manual update', async () => {
    const directory = await temporaryDirectory()
    const calls: string[] = []
    const responses = feedResponses('phish.example\n', 'https://phish.example/login\n')
    const database = createPhishingDatabase({
      directory,
      fetch: mockFetch(responses, calls),
      now: () => 200_000,
      updateIntervalMs: 60_000,
    })

    expect((await database.update()).updated).toBe(true)
    expect((await database.update()).skipped).toBe(true)
    expect(calls).toHaveLength(4)
    expect((await database.update({ force: true })).updated).toBe(true)
    expect(calls).toHaveLength(8)
    database.close()
  })

  test('uses a commit-pinned official GitHub snapshot when the published feed is unavailable', async () => {
    const directory = await temporaryDirectory()
    const calls: string[] = []
    const revision = 'c'.repeat(40)
    const responses = githubResponses(
      'fallback-domain.example\n',
      'https://fallback-url.example/sign-in\n',
      revision,
    )
    const database = createPhishingDatabase({ directory, fetch: mockFetch(responses, calls), now: () => 300_000 })

    const update = await database.update()

    expect(update).toMatchObject({ updated: true, error: null })
    expect(database.status()).toMatchObject({
      source: 'github-snapshot',
      domainCount: 1,
      urlCount: 1,
      updatedAt: 300_000,
    })
    expect(database.check('https://fallback-domain.example/path')).toMatchObject({
      hit: true,
      type: 'domain',
      source: `${PHISHING_DATABASE_SOURCES.github.raw}${revision}/${PHISHING_DATABASE_SOURCES.github.domainsPath}`,
    })
    expect(database.check('https://fallback-url.example/sign-in')).toMatchObject({
      hit: true,
      type: 'url',
      source: `${PHISHING_DATABASE_SOURCES.github.raw}${revision}/${PHISHING_DATABASE_SOURCES.github.urlsPath}`,
    })
    expect(calls).not.toContain('https://attacker.invalid/domain-data')
    expect(calls).not.toContain('https://attacker.invalid/url-data')
    database.close()
  })

  test('rejects a GitHub fallback whose bytes do not match the pinned tree and preserves the last good data', async () => {
    const directory = await temporaryDirectory()
    const calls: string[] = []
    const responses = feedResponses('known.example\n', 'https://known.example/login\n')
    const database = createPhishingDatabase({ directory, fetch: mockFetch(responses, calls) })
    expect((await database.update()).updated).toBe(true)

    responses.clear()
    const fallback = githubResponses('replacement.example\n', 'https://replacement.example/login\n')
    for (const [url, body] of fallback) responses.set(url, body)
    const rawDomainUrl = `${PHISHING_DATABASE_SOURCES.github.raw}${'a'.repeat(40)}/${PHISHING_DATABASE_SOURCES.github.domainsPath}`
    responses.set(rawDomainUrl, 'xeplacement.example\n')

    const update = await database.update({ force: true })

    expect(update.updated).toBe(false)
    expect(update.error).toContain('does not match its Git blob hash')
    expect(database.status().source).toBe('published-checksum')
    expect(database.check('https://known.example/').hit).toBe(true)
    expect(database.check('https://replacement.example/').hit).toBe(false)
    database.close()
  })

  test('does not activate an empty verified GitHub snapshot or report an unchecked miss as protected', async () => {
    const directory = await temporaryDirectory()
    const responses = githubResponses('# no domains available\n', 'https://listed.example/login\n')
    const database = createPhishingDatabase({ directory, fetch: mockFetch(responses, []) })

    const update = await database.update()

    expect(update.updated).toBe(false)
    expect(update.error).toContain('no usable entries')
    expect(database.status()).toMatchObject({ source: null, updatedAt: null, domainCount: 0, urlCount: 0 })
    expect(database.check('https://unknown.example/')).toMatchObject({ hit: false, source: null, updatedAt: null, stale: true })
    database.close()
  })

  test('retains the last known good database after checksum, HTML, and empty-feed failures', async () => {
    const directory = await temporaryDirectory()
    const calls: string[] = []
    const responses = feedResponses('known-bad.example\n', 'https://known-url.example/sign-in\n')
    const database = createPhishingDatabase({ directory, fetch: mockFetch(responses, calls) })
    expect((await database.update()).updated).toBe(true)
    const goodUpdatedAt = database.status().updatedAt

    responses.set(PHISHING_DATABASE_SOURCES.domains.data, 'tampered.example\n')
    const checksumFailure = await database.update({ force: true })
    expect(checksumFailure.error).toContain('SHA-256')
    expect(database.check('https://known-bad.example/').hit).toBe(true)

    const html = '<!doctype html><html><body>upstream error</body></html>'
    responses.set(PHISHING_DATABASE_SOURCES.domains.data, html)
    responses.set(PHISHING_DATABASE_SOURCES.domains.checksum, `${sha256(html)} *phishing-domains-ACTIVE.txt`)
    const htmlFailure = await database.update({ force: true })
    expect(htmlFailure.error).toContain('HTML')
    expect(database.check('https://known-bad.example/').hit).toBe(true)

    responses.set(PHISHING_DATABASE_SOURCES.domains.data, '# temporarily empty\n')
    responses.set(
      PHISHING_DATABASE_SOURCES.domains.checksum,
      `${sha256('# temporarily empty\n')} *phishing-domains-ACTIVE.txt`,
    )
    const emptyFailure = await database.update({ force: true })
    expect(emptyFailure.error).toContain('no usable entries')
    expect(database.status().updatedAt).toBe(goodUpdatedAt)
    expect(database.status().domainCount).toBe(1)
    expect(database.check('https://known-bad.example/').hit).toBe(true)
    database.close()
  })

  test('tolerates a tiny amount of feed noise but rejects materially corrupted data', async () => {
    const directory = await temporaryDirectory()
    const calls: string[] = []
    const mostlyValid = `${Array.from({ length: 1_001 }, (_, index) => `phish-${index}.example`).join('\n')}\nnot a domain/path\n`
    const urls = 'https://phish.example/login\n'
    const responses = feedResponses(mostlyValid, urls)
    const database = createPhishingDatabase({ directory, fetch: mockFetch(responses, calls) })

    const usable = await database.update()
    expect(usable.updated).toBe(true)
    expect(database.status().domainCount).toBe(1_001)

    const corrupted = 'valid.example\ninvalid path\nalso/invalid\n'
    responses.set(PHISHING_DATABASE_SOURCES.domains.data, corrupted)
    responses.set(
      PHISHING_DATABASE_SOURCES.domains.checksum,
      `${sha256(corrupted)} *phishing-domains-ACTIVE.txt`,
    )
    const rejected = await database.update({ force: true })
    expect(rejected.updated).toBe(false)
    expect(rejected.error).toContain('rejected 2 invalid entries')
    expect(database.status().domainCount).toBe(1_001)
    database.close()
  })

  test('rejects oversized downloads before replacing local data', async () => {
    const directory = await temporaryDirectory()
    const calls: string[] = []
    const responses = feedResponses('domain-that-is-too-large.example\n', 'https://url-is-too-large.example/path\n')
    const database = createPhishingDatabase({
      directory,
      fetch: mockFetch(responses, calls),
      maxBytes: 16,
    })

    const update = await database.update()

    expect(update.updated).toBe(false)
    expect(update.error).toContain('16-byte limit')
    expect(database.status()).toMatchObject({ domainCount: 0, urlCount: 0, updatedAt: null })
    database.close()
  })

  test('rejects a truncated response even if its partial body has a matching checksum', async () => {
    const directory = await temporaryDirectory()
    const domains = 'partial.example\n'
    const urls = 'https://complete.example/login\n'
    const responses = feedResponses(domains, urls)
    const baseFetch = mockFetch(responses, [])
    const truncatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === PHISHING_DATABASE_SOURCES.domains.data) {
        return new Response(domains, { headers: { 'content-length': String(domains.length + 100) } })
      }
      return baseFetch(input, init)
    }) as unknown as typeof fetch
    const database = createPhishingDatabase({ directory, fetch: truncatedFetch })

    const update = await database.update()

    expect(update.updated).toBe(false)
    expect(update.error).toContain('declared content length')
    expect(database.status().updatedAt).toBeNull()
    database.close()
  })

  test('bounds stalled source requests with a timeout', async () => {
    const directory = await temporaryDirectory()
    const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const database = createPhishingDatabase({ directory, fetch: stalledFetch, timeoutMs: 5 })

    const update = await database.update()

    expect(update.updated).toBe(false)
    expect(update.error).toContain('Published feed unavailable: Download timed out.')
    expect(update.error).toContain('Official GitHub snapshot unavailable: Download timed out.')
    expect(database.status().updatedAt).toBeNull()
    database.close()
  })

  test('loads the atomic snapshot for offline checks in a later session', async () => {
    const directory = await temporaryDirectory()
    const responses = feedResponses('persisted.example\n', 'https://persisted-url.example/login\n')
    const first = createPhishingDatabase({ directory, fetch: mockFetch(responses, []) })
    expect((await first.update()).updated).toBe(true)
    const updatedAt = first.status().updatedAt
    first.close()

    const second = createPhishingDatabase({
      directory,
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })
    await waitUntilLoaded(second)

    expect(second.status()).toMatchObject({ domainCount: 1, urlCount: 1, updatedAt })
    expect(second.status().source).toBe('published-checksum')
    expect(second.check('https://persisted.example/path').hit).toBe(true)
    expect(second.check('https://persisted-url.example/login').type).toBe('url')
    second.close()
  })

  test('preserves GitHub snapshot provenance when loading the database offline', async () => {
    const directory = await temporaryDirectory()
    const revision = 'd'.repeat(40)
    const first = createPhishingDatabase({
      directory,
      fetch: mockFetch(githubResponses('offline-fallback.example\n', 'https://offline-url.example/login\n', revision), []),
    })
    expect((await first.update()).updated).toBe(true)
    first.close()

    const second = createPhishingDatabase({
      directory,
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })
    await waitUntilLoaded(second)

    expect(second.status()).toMatchObject({ source: 'github-snapshot', domainCount: 1, urlCount: 1 })
    expect(second.check('https://offline-fallback.example/path')).toMatchObject({
      hit: true,
      source: `${PHISHING_DATABASE_SOURCES.github.raw}${revision}/${PHISHING_DATABASE_SOURCES.github.domainsPath}`,
    })
    second.close()
  })
})
