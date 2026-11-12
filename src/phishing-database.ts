import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PHISHING_DATABASE_SOURCES = Object.freeze({
  domains: Object.freeze({
    data: 'https://phish.co.za/latest/phishing-domains-ACTIVE.txt',
    checksum: 'https://raw.githubusercontent.com/Phishing-Database/checksums/refs/heads/master/phishing-domains-ACTIVE.txt.sha256',
  }),
  urls: Object.freeze({
    data: 'https://phish.co.za/latest/phishing-links-ACTIVE.txt',
    checksum: 'https://raw.githubusercontent.com/Phishing-Database/checksums/refs/heads/master/phishing-links-ACTIVE.txt.sha256',
  }),
  github: Object.freeze({
    commit: 'https://api.github.com/repos/Phishing-Database/Phishing.Database/commits/master',
    tree: 'https://api.github.com/repos/Phishing-Database/Phishing.Database/git/trees/',
    raw: 'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/',
    domainsPath: 'phishing-domains-ACTIVE.txt',
    urlsPath: 'phishing-links-ACTIVE.txt',
  }),
})

export type PhishingDatabaseSource = 'published-checksum' | 'github-snapshot'

export interface PhishingDatabaseStatus {
  loading: boolean
  updating: boolean
  updatedAt: number | null
  nextUpdateAt: number | null
  stale: boolean
  domainCount: number
  urlCount: number
  source: PhishingDatabaseSource | null
  lastError: string | null
}

export interface PhishingCheckResult {
  hit: boolean
  type: 'domain' | 'url' | null
  source: string | null
  matched: string | null
  updatedAt: number | null
  stale: boolean
}

export interface PhishingUpdateResult {
  updated: boolean
  skipped: boolean
  error: string | null
  status: PhishingDatabaseStatus
}

export interface PhishingDatabase {
  status(): PhishingDatabaseStatus
  subscribe(listener: () => void): () => void
  check(url: string): PhishingCheckResult
  update(options?: { force?: boolean }): Promise<PhishingUpdateResult>
  close(): void
}

/**
 * Sorted 64-bit hashes of the canonical entries. A million strings in Sets cost
 * hundreds of MiB; this costs 8 bytes each, is transferable between threads and
 * answers exact lookups with one hash and a binary search. A false positive needs
 * a 64-bit wyhash collision (about 1 in 10^13 per lookup at feed size).
 */
export interface PhishingIndex {
  domains: BigUint64Array
  urls: BigUint64Array
  source: PhishingDatabaseSource | null
  revision: string | null
}

export const EMPTY_PHISHING_INDEX: PhishingIndex = Object.freeze({
  domains: new BigUint64Array(0),
  urls: new BigUint64Array(0),
  source: null,
  revision: null,
})

const entryHash = (value: string) => Bun.hash.wyhash(value, 0n)

export function buildPhishingHashes(values: Iterable<string>): BigUint64Array {
  const list = Array.isArray(values) ? values as string[] : [...values]
  const hashes = new BigUint64Array(list.length)
  for (let index = 0; index < list.length; index++) hashes[index] = entryHash(list[index]!)
  hashes.sort()
  return hashes
}

function hasHash(hashes: BigUint64Array, value: string): boolean {
  const target = entryHash(value)
  let low = 0
  let high = hashes.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const candidate = hashes[middle]!
    if (candidate === target) return true
    if (candidate < target) low = middle + 1
    else high = middle - 1
  }
  return false
}

/** Exact URL, then exact host lookup; shared by the worker-side core and the UI-side client. */
export function checkPhishingIndex(index: PhishingIndex, status: PhishingDatabaseStatus, rawUrl: string): PhishingCheckResult {
  const miss = { hit: false, type: null, source: null, matched: null, updatedAt: status.updatedAt, stale: status.stale }
  if (index.domains.length === 0 && index.urls.length === 0) return miss
  const url = canonicalWebUrl(rawUrl)
  if (url === null) return miss
  if (hasHash(index.urls, url)) {
    return {
      hit: true,
      type: 'url',
      source: index.source ? sourceUrl(index.source, index.revision, 'url') : null,
      matched: url,
      updatedAt: status.updatedAt,
      stale: status.stale,
    }
  }
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  if (hasHash(index.domains, host)) {
    return {
      hit: true,
      type: 'domain',
      source: index.source ? sourceUrl(index.source, index.revision, 'domain') : null,
      matched: host,
      updatedAt: status.updatedAt,
      stale: status.stale,
    }
  }
  return miss
}

export interface CreatePhishingDatabaseOptions {
  directory: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  updateIntervalMs?: number
  timeoutMs?: number
  maxBytes?: number
  maxFallbackBytes?: number
  maxEntries?: number
  /** Called whenever the lookup index is replaced (the worker forwards it to the UI). */
  onIndex?: (index: PhishingIndex) => void
}

interface StoredDatabaseV1 {
  version: 1
  updatedAt: number
  checksums: { domains: string; urls: string }
  domains: string[]
  urls: string[]
}

interface StoredDatabaseV2 {
  version: 2
  updatedAt: number
  source: PhishingDatabaseSource
  revision: string | null
  integrity: { algorithm: 'sha256' | 'git-sha1'; domains: string; urls: string }
  domains: string[]
  urls: string[]
}

type StoredDatabase = StoredDatabaseV1 | StoredDatabaseV2

interface ParsedFeeds {
  domains: Set<string>
  urls: Set<string>
  source: PhishingDatabaseSource
  revision: string | null
  integrity: StoredDatabaseV2['integrity']
}

const SNAPSHOT_NAME = 'phishing-database-v1.json'
export const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_FALLBACK_BYTES = 96 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 2_000_000
const CHECKSUM_MAX_BYTES = 4_096
const GITHUB_METADATA_MAX_BYTES = 2 * 1024 * 1024
const MAX_LINE_LENGTH = 8_192
const YIELD_EVERY = 5_000
const MAX_REJECTED_LINES = 5_000
const MAX_REJECTED_FRACTION = 0.001

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function canonicalWebUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1)
  url.hash = ''
  return url.href
}

function strictDomain(raw: string): string | null {
  const value = raw.trim()
  if (!value || /[\s/@:?#*]/.test(value)) return null
  let url: URL
  try {
    url = new URL(`https://${value}/`)
  } catch {
    return null
  }
  const normalized = url.hostname.toLowerCase().replace(/\.$/, '')
  // Threat feeds include some legacy hostnames with underscores which browsers
  // still parse. Accept those exact hosts here without relaxing the user's
  // trusted-domain settings validator.
  if (!normalized || !/^[a-z\d._-]+$/i.test(normalized) || normalized.includes('..')) return null
  return normalized
}

function isHtml(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html|<head|<body)\b/i.test(text)
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = response.headers.get('content-length')
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader)
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Download exceeds the ${maxBytes}-byte limit.`)
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`Download exceeds the ${maxBytes}-byte limit.`)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new Error(`Download exceeds the ${maxBytes}-byte limit.`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (
    declaredLength !== null
    && Number.isFinite(declaredLength)
    && !response.headers.has('content-encoding')
    && length < declaredLength
  ) {
    throw new Error('Download ended before the declared content length.')
  }
  return joined
}

async function fetchBytes(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
  maxBytes: number,
  controllers: Set<AbortController>,
  accept = 'text/plain',
): Promise<Uint8Array> {
  const controller = new AbortController()
  controllers.add(controller)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept },
    })
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`)
    return await readBounded(response, maxBytes)
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Download timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
    controllers.delete(controller)
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Download is not valid UTF-8 text.')
  }
}

function expectedChecksum(text: string): string {
  const match = text.trim().match(/^([a-f\d]{64})(?:\s+\*?[^\s]+)?$/i)
  if (!match) throw new Error('Checksum file is malformed.')
  return match[1]!.toLowerCase()
}

async function verifiedFeed(
  fetchImpl: typeof globalThis.fetch,
  source: { data: string; checksum: string },
  timeoutMs: number,
  maxBytes: number,
  controllers: Set<AbortController>,
): Promise<{ text: string; checksum: string }> {
  const [data, checksumBytes] = await Promise.all([
    fetchBytes(fetchImpl, source.data, timeoutMs, maxBytes, controllers),
    fetchBytes(fetchImpl, source.checksum, timeoutMs, CHECKSUM_MAX_BYTES, controllers),
  ])
  const checksum = expectedChecksum(decodeUtf8(checksumBytes))
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== checksum) throw new Error('Downloaded feed does not match its published SHA-256 checksum.')

  const text = decodeUtf8(data)
  if (isHtml(text)) throw new Error('Downloaded feed contains HTML instead of threat data.')
  return { text, checksum }
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(decodeUtf8(bytes))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new Error(`${label} metadata is malformed.`)
  }
}

function exactSha(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f\d]{40}$/.test(value) ? value : null
}

function githubRawUrl(revision: string, path: string): string {
  return `${PHISHING_DATABASE_SOURCES.github.raw}${revision}/${path}`
}

async function githubSnapshotFeeds(
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
  maxBytes: number,
  maxEntries: number,
  controllers: Set<AbortController>,
  isClosed: () => boolean,
): Promise<ParsedFeeds> {
  const commitMetadata = parseJsonObject(await fetchBytes(
    fetchImpl,
    PHISHING_DATABASE_SOURCES.github.commit,
    timeoutMs,
    GITHUB_METADATA_MAX_BYTES,
    controllers,
    'application/vnd.github+json',
  ), 'GitHub commit')
  if (isClosed()) throw new Error('Phishing database is closed.')
  const revision = exactSha(commitMetadata.sha)
  const commit = commitMetadata.commit
  const tree = typeof commit === 'object' && commit !== null && !Array.isArray(commit)
    ? (commit as Record<string, unknown>).tree
    : null
  const treeSha = typeof tree === 'object' && tree !== null && !Array.isArray(tree)
    ? exactSha((tree as Record<string, unknown>).sha)
    : null
  if (!revision || !treeSha) throw new Error('GitHub commit metadata is malformed.')

  const treeMetadata = parseJsonObject(await fetchBytes(
    fetchImpl,
    `${PHISHING_DATABASE_SOURCES.github.tree}${treeSha}`,
    timeoutMs,
    GITHUB_METADATA_MAX_BYTES,
    controllers,
    'application/vnd.github+json',
  ), 'GitHub tree')
  if (isClosed()) throw new Error('Phishing database is closed.')
  if (exactSha(treeMetadata.sha) !== treeSha || treeMetadata.truncated === true || !Array.isArray(treeMetadata.tree)) {
    throw new Error('GitHub tree metadata is incomplete.')
  }
  const treeEntries = treeMetadata.tree as unknown[]

  const expected = (path: string) => {
    const entry = treeEntries.find((candidate: unknown) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false
      return (candidate as Record<string, unknown>).path === path
    }) as Record<string, unknown> | undefined
    const sha = exactSha(entry?.sha)
    const size = entry?.size
    if (!entry || entry.type !== 'blob' || !sha || !Number.isSafeInteger(size) || Number(size) <= 0 || Number(size) > maxBytes) {
      throw new Error(`GitHub metadata for ${path} is invalid or exceeds the download limit.`)
    }
    return { sha, size: Number(size) }
  }

  const domainExpected = expected(PHISHING_DATABASE_SOURCES.github.domainsPath)
  const urlExpected = expected(PHISHING_DATABASE_SOURCES.github.urlsPath)
  const [domainBytes, urlBytes] = await Promise.all([
    fetchBytes(
      fetchImpl,
      githubRawUrl(revision, PHISHING_DATABASE_SOURCES.github.domainsPath),
      timeoutMs,
      maxBytes,
      controllers,
    ),
    fetchBytes(
      fetchImpl,
      githubRawUrl(revision, PHISHING_DATABASE_SOURCES.github.urlsPath),
      timeoutMs,
      maxBytes,
      controllers,
    ),
  ])

  const verifyBlob = (bytes: Uint8Array, expectedBlob: { sha: string; size: number }, path: string) => {
    if (bytes.byteLength !== expectedBlob.size) throw new Error(`GitHub snapshot size for ${path} does not match its tree metadata.`)
    const actual = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
    if (actual !== expectedBlob.sha) throw new Error(`GitHub snapshot for ${path} does not match its Git blob hash.`)
    const text = decodeUtf8(bytes)
    if (isHtml(text)) throw new Error(`GitHub snapshot for ${path} contains HTML instead of threat data.`)
    return text
  }
  const domainText = verifyBlob(domainBytes, domainExpected, PHISHING_DATABASE_SOURCES.github.domainsPath)
  const urlText = verifyBlob(urlBytes, urlExpected, PHISHING_DATABASE_SOURCES.github.urlsPath)
  const [domains, urls] = await Promise.all([
    parseLines(domainText, 'domain', maxEntries),
    parseLines(urlText, 'url', maxEntries),
  ])
  return {
    domains,
    urls,
    source: 'github-snapshot',
    revision,
    integrity: { algorithm: 'git-sha1', domains: domainExpected.sha, urls: urlExpected.sha },
  }
}

async function primaryFeeds(
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
  maxBytes: number,
  maxEntries: number,
  controllers: Set<AbortController>,
): Promise<ParsedFeeds> {
  const [domainFeed, urlFeed] = await Promise.all([
    verifiedFeed(fetchImpl, PHISHING_DATABASE_SOURCES.domains, timeoutMs, maxBytes, controllers),
    verifiedFeed(fetchImpl, PHISHING_DATABASE_SOURCES.urls, timeoutMs, maxBytes, controllers),
  ])
  const [domains, urls] = await Promise.all([
    parseLines(domainFeed.text, 'domain', maxEntries),
    parseLines(urlFeed.text, 'url', maxEntries),
  ])
  return {
    domains,
    urls,
    source: 'published-checksum',
    revision: null,
    integrity: { algorithm: 'sha256', domains: domainFeed.checksum, urls: urlFeed.checksum },
  }
}

async function parseLines(
  text: string,
  kind: 'domain' | 'url',
  maxEntries: number,
): Promise<Set<string>> {
  const values = new Set<string>()
  const lines = text.split(/\r?\n/)
  let accepted = 0
  let rejected = 0
  let firstInvalidLine = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.length <= MAX_LINE_LENGTH
      ? kind === 'domain' ? strictDomain(line) : canonicalWebUrl(line)
      : null
    if (normalized === null) {
      rejected++
      if (firstInvalidLine === 0) firstInvalidLine = index + 1
      if (rejected > MAX_REJECTED_LINES) throw new Error(`${kind} feed contains too many invalid entries.`)
    } else {
      accepted++
      values.add(normalized)
    }
    if (values.size > maxEntries) throw new Error(`${kind} feed exceeds the ${maxEntries}-entry limit.`)
    if (index > 0 && index % YIELD_EVERY === 0) await yieldToEventLoop()
  }
  if (values.size === 0) throw new Error(`${kind} feed contains no usable entries.`)
  if (rejected / (accepted + rejected) > MAX_REJECTED_FRACTION) {
    throw new Error(`${kind} feed rejected ${rejected} invalid entries, starting on line ${firstInvalidLine}.`)
  }
  return values
}

async function setsFromStored(database: StoredDatabase, maxEntries: number): Promise<{
  domains: BigUint64Array
  urls: BigUint64Array
  source: PhishingDatabaseSource
  revision: string | null
}> {
  if (
    (database.version !== 1 && database.version !== 2)
    || !Number.isFinite(database.updatedAt)
    || database.updatedAt <= 0
    || !Array.isArray(database.domains)
    || !Array.isArray(database.urls)
    || database.domains.length > maxEntries
    || database.urls.length > maxEntries
  ) {
    throw new Error('Stored phishing database metadata is invalid.')
  }

  let source: PhishingDatabaseSource
  let revision: string | null
  if (database.version === 1) {
    if (
      !/^[a-f\d]{64}$/i.test(database.checksums?.domains ?? '')
      || !/^[a-f\d]{64}$/i.test(database.checksums?.urls ?? '')
    ) throw new Error('Stored phishing database metadata is invalid.')
    source = 'published-checksum'
    revision = null
  } else {
    const digestLength = database.integrity?.algorithm === 'sha256' ? 64 : database.integrity?.algorithm === 'git-sha1' ? 40 : 0
    const digestPattern = new RegExp(`^[a-f\\d]{${digestLength}}$`, 'i')
    if (
      (database.source !== 'published-checksum' && database.source !== 'github-snapshot')
      || (database.source === 'published-checksum' && (database.revision !== null || database.integrity?.algorithm !== 'sha256'))
      || (database.source === 'github-snapshot' && (!exactSha(database.revision) || database.integrity?.algorithm !== 'git-sha1'))
      || !digestPattern.test(database.integrity?.domains ?? '')
      || !digestPattern.test(database.integrity?.urls ?? '')
    ) throw new Error('Stored phishing database metadata is invalid.')
    source = database.source
    revision = database.revision
  }

  for (let index = 0; index < database.domains.length; index++) {
    const value = database.domains[index]
    if (typeof value !== 'string' || strictDomain(value) !== value) {
      throw new Error('Stored phishing domain data is invalid.')
    }
    if (index > 0 && index % YIELD_EVERY === 0) await yieldToEventLoop()
  }

  for (let index = 0; index < database.urls.length; index++) {
    const value = database.urls[index]
    if (typeof value !== 'string' || canonicalWebUrl(value) !== value) {
      throw new Error('Stored phishing URL data is invalid.')
    }
    if (index > 0 && index % YIELD_EVERY === 0) await yieldToEventLoop()
  }
  if (database.domains.length === 0 || database.urls.length === 0) throw new Error('Stored phishing database is empty.')
  // Stored snapshots were written from Sets, so entries are already unique.
  return { domains: buildPhishingHashes(database.domains), urls: buildPhishingHashes(database.urls), source, revision }
}

function sourceUrl(source: PhishingDatabaseSource, revision: string | null, kind: 'domain' | 'url'): string {
  if (source === 'published-checksum') {
    return kind === 'domain' ? PHISHING_DATABASE_SOURCES.domains.data : PHISHING_DATABASE_SOURCES.urls.data
  }
  if (!revision) throw new Error('GitHub snapshot revision is missing.')
  const path = kind === 'domain'
    ? PHISHING_DATABASE_SOURCES.github.domainsPath
    : PHISHING_DATABASE_SOURCES.github.urlsPath
  return githubRawUrl(revision, path)
}

export function createPhishingDatabase(options: CreatePhishingDatabaseOptions): PhishingDatabase {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const updateIntervalMs = options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFallbackBytes = options.maxFallbackBytes ?? DEFAULT_MAX_FALLBACK_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  if (!options.directory) throw new Error('A phishing database directory is required.')
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.')
  if (!Number.isFinite(updateIntervalMs) || updateIntervalMs < 0) throw new Error('updateIntervalMs must be non-negative.')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive.')
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be positive.')
  if (!Number.isFinite(maxFallbackBytes) || maxFallbackBytes <= 0) throw new Error('maxFallbackBytes must be positive.')
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error('maxEntries must be a positive integer.')

  const snapshotPath = join(options.directory, SNAPSHOT_NAME)
  const listeners = new Set<() => void>()
  const controllers = new Set<AbortController>()
  let index: PhishingIndex = EMPTY_PHISHING_INDEX
  const setIndex = (next: PhishingIndex) => {
    index = next
    options.onIndex?.(next)
  }
  let closed = false
  let inFlight: Promise<PhishingUpdateResult> | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let lastAttemptAt: number | null = null
  let currentStatus: PhishingDatabaseStatus = Object.freeze({
    loading: true,
    updating: false,
    updatedAt: null,
    nextUpdateAt: null,
    stale: true,
    domainCount: 0,
    urlCount: 0,
    source: null,
    lastError: null,
  })

  const publish = (patch: Partial<PhishingDatabaseStatus>) => {
    currentStatus = Object.freeze({ ...currentStatus, ...patch })
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A UI subscriber must not break database updates or other subscribers.
      }
    }
  }

  const scheduleStale = () => {
    if (staleTimer) clearTimeout(staleTimer)
    staleTimer = null
    if (closed || currentStatus.updatedAt === null || currentStatus.stale || updateIntervalMs === 0) return
    const remaining = currentStatus.updatedAt + updateIntervalMs - now()
    if (remaining <= 0) {
      publish({ stale: true })
      return
    }
    staleTimer = setTimeout(() => {
      staleTimer = null
      if (!closed) publish({ stale: true })
    }, Math.min(remaining, 2_147_483_647))
    staleTimer.unref?.()
  }

  const initialization = (async () => {
    try {
      // One open file for the size check and the read, so a swapped file can't slip past the limit.
      const handle = await open(snapshotPath, 'r')
      let text: string
      try {
        if ((await handle.stat()).size > Math.max(maxBytes * 3, maxFallbackBytes * 2)) throw new Error('Stored phishing database exceeds its size limit.')
        text = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
      const parsed = JSON.parse(text) as StoredDatabase
      const loaded = await setsFromStored(parsed, maxEntries)
      if (closed) return
      setIndex(Object.freeze(loaded))
      lastAttemptAt = parsed.updatedAt
      const stale = now() - parsed.updatedAt >= updateIntervalMs
      publish({
        loading: false,
        updatedAt: parsed.updatedAt,
        nextUpdateAt: parsed.updatedAt + updateIntervalMs,
        stale,
        domainCount: loaded.domains.length,
        urlCount: loaded.urls.length,
        source: loaded.source,
        lastError: null,
      })
      scheduleStale()
    } catch (error) {
      if (closed) return
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      publish({ loading: false, lastError: missing ? null : errorMessage(error) })
    }
  })()

  const result = (updated: boolean, skipped: boolean, error: string | null): PhishingUpdateResult => ({
    updated,
    skipped,
    error,
    status: currentStatus,
  })

  const database: PhishingDatabase = {
    status: () => currentStatus,

    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    check: (rawUrl) => checkPhishingIndex(index, currentStatus, rawUrl),

    update(updateOptions = {}) {
      if (inFlight) return inFlight
      inFlight = (async () => {
        await initialization
        if (closed) return result(false, false, 'Phishing database is closed.')

        const startedAt = now()
        if (!updateOptions.force && lastAttemptAt !== null && startedAt - lastAttemptAt < updateIntervalMs) {
          return result(false, true, null)
        }
        lastAttemptAt = startedAt
        publish({ updating: true, nextUpdateAt: startedAt + updateIntervalMs, lastError: null })

        try {
          let feeds: ParsedFeeds
          try {
            feeds = await primaryFeeds(fetchImpl, timeoutMs, maxBytes, maxEntries, controllers)
          } catch (primaryError) {
            if (closed) throw new Error('Phishing database is closed.')
            try {
              feeds = await githubSnapshotFeeds(fetchImpl, timeoutMs, maxFallbackBytes, maxEntries, controllers, () => closed)
            } catch (fallbackError) {
              throw new Error(
                `Published feed unavailable: ${errorMessage(primaryError)} Official GitHub snapshot unavailable: ${errorMessage(fallbackError)}`,
              )
            }
          }
          if (closed) throw new Error('Phishing database is closed.')
          const updatedAt = now()
          const stored: StoredDatabaseV2 = {
            version: 2,
            updatedAt,
            source: feeds.source,
            revision: feeds.revision,
            integrity: feeds.integrity,
            domains: [...feeds.domains],
            urls: [...feeds.urls],
          }
          await mkdir(options.directory, { recursive: true, mode: 0o700 })
          const temporaryPath = join(options.directory, `${SNAPSHOT_NAME}.${randomUUID()}.tmp`)
          try {
            await writeFile(temporaryPath, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 })
            await rename(temporaryPath, snapshotPath)
          } catch (error) {
            await rm(temporaryPath, { force: true })
            throw error
          }

          if (closed) return result(false, false, 'Phishing database is closed.')
          const domainCount = feeds.domains.size
          const urlCount = feeds.urls.size
          setIndex(Object.freeze({
            domains: buildPhishingHashes(stored.domains),
            urls: buildPhishingHashes(stored.urls),
            source: feeds.source,
            revision: feeds.revision,
          }))
          publish({
            loading: false,
            updating: false,
            updatedAt,
            nextUpdateAt: startedAt + updateIntervalMs,
            stale: updateIntervalMs === 0,
            domainCount,
            urlCount,
            source: feeds.source,
            lastError: null,
          })
          scheduleStale()
          return result(true, false, null)
        } catch (error) {
          const message = errorMessage(error)
          const stale = currentStatus.updatedAt === null || now() - currentStatus.updatedAt >= updateIntervalMs
          publish({ updating: false, stale, lastError: message })
          scheduleStale()
          return result(false, false, message)
        }
      })().finally(() => {
        inFlight = null
      })
      return inFlight
    },

    close() {
      if (closed) return
      closed = true
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = null
      for (const controller of controllers) controller.abort()
      controllers.clear()
      listeners.clear()
    },
  }

  return database
}
