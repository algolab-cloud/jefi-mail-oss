/**
 * Loads a synthetic phishing snapshot the size of the lume-2na audit (400k domains
 * + 800k URLs, ~74 MB JSON) and reports UI-thread heartbeat gaps, RSS and lookup latency.
 *   bun scripts/testing/phishing-benchmark.ts [--in-process] [--domains N] [--urls N]
 * The default path loads through the worker; --in-process measures the old behaviour.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { heapStats } from 'bun:jsc'
import { join } from 'node:path'
import { createPhishingDatabase, type PhishingDatabase } from '../../src/phishing-database'
import { createWorkerPhishingDatabase } from '../../src/phishing-worker-client'

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : Number(process.argv[index + 1])
}
const inProcess = process.argv.includes('--in-process')
const domainCount = arg('--domains', 400_000)
const urlCount = arg('--urls', 800_000)
const maxGapMs = arg('--max-gap', 30)

if (process.argv[2] === '--write') {
  const [, , , target, domainTotal, urlTotal] = process.argv
  const domains = Array.from({ length: Number(domainTotal) }, (_, i) => `phish-${i.toString(36)}-login.example${i % 97}.com`)
  const urls = Array.from({ length: Number(urlTotal) }, (_, i) => `https://host-${(i % 50_000).toString(36)}.example.net/account/verify/${i.toString(36)}?session=${(i * 7919).toString(36)}&ref=mail`)
  writeFileSync(join(target!, 'phishing-database-v1.json'), JSON.stringify({
    version: 2,
    updatedAt: Date.now(),
    source: 'published-checksum',
    revision: null,
    integrity: { algorithm: 'sha256', domains: 'a'.repeat(64), urls: 'b'.repeat(64) },
    domains,
    urls,
  }))
  process.exit(0)
}

const directory = mkdtempSync(join(tmpdir(), 'jefi-phishing-benchmark-'))
try {
  // Build the fixture in a child so its strings don't pre-grow this heap and hide RSS.
  Bun.spawnSync([process.execPath, import.meta.path, '--write', directory, String(domainCount), String(urlCount)], { stdout: 'inherit', stderr: 'inherit' })
  const snapshotBytes = Bun.file(join(directory, 'phishing-database-v1.json')).size

  Bun.gc(true)
  const baselineHeap = heapStats().heapSize
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  let maxGap = 0
  let last = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last - 5)
    last = now
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 5)

  const started = performance.now()
  const options = { directory, maxBytes: 64 * 1024 * 1024 }
  const database: PhishingDatabase = inProcess ? createPhishingDatabase(options) : createWorkerPhishingDatabase(options)
  await new Promise<void>((resolve) => {
    const check = () => { if (!database.status().loading) resolve() }
    database.subscribe(check)
    check()
  })
  const loadMs = performance.now() - started
  clearInterval(heartbeat)
  if (database.status().lastError) throw new Error(database.status().lastError!)

  const probes = [
    `https://phish-${(12345).toString(36)}-login.example${12345 % 97}.com/`,
    `https://host-${(777 % 50_000).toString(36)}.example.net/account/verify/${(777).toString(36)}?session=${(777 * 7919).toString(36)}&ref=mail`,
    'https://safe.example.org/inbox',
  ]
  const expected = [true, true, false]
  const rounds = 20_000
  const lookupStarted = performance.now()
  for (let round = 0; round < rounds; round++) {
    const probe = round % probes.length
    if (database.check(probes[probe]!).hit !== expected[probe]) throw new Error(`Wrong lookup result for ${probes[probe]}`)
  }
  const lookupUs = (performance.now() - lookupStarted) * 1_000 / rounds
  // Let the retired worker's thread and heap unwind before sampling. RSS still
  // includes pages the allocator keeps; the live heap is what this thread retains.
  for (let round = 0; round < 6; round++) {
    await Bun.sleep(500)
    Bun.gc(true)
  }
  const liveHeap = heapStats().heapSize
  const settledRss = process.memoryUsage().rss
  database.close()

  const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)
  console.log(JSON.stringify({
    mode: inProcess ? 'in-process' : 'worker',
    snapshotMB: +(snapshotBytes / 1e6).toFixed(2),
    domains: database.status().domainCount || domainCount,
    urls: urlCount,
    loadMs: Math.round(loadMs),
    maxHeartbeatGapMs: Math.round(maxGap),
    peakRssGrowthMiB: +mib(peakRss - baselineRss),
    settledRssGrowthMiB: +mib(settledRss - baselineRss),
    liveHeapGrowthMiB: +mib(liveHeap - baselineHeap),
    lookupUs: +lookupUs.toFixed(2),
  }))
  if (!inProcess && maxGap > maxGapMs) {
    console.error(`UI-thread heartbeat gap ${Math.round(maxGap)} ms exceeds ${maxGapMs} ms`)
    process.exitCode = 1
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
