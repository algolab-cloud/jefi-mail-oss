/**
 * First-sync benchmark through the real engine worker against a disposable local IMAP server.
 *   bun scripts/testing/sync-benchmark.ts [message-count]
 * The server runs in the parent, so reported child RSS excludes the fixture mailbox allocation.
 * This measures local engine work, not production network latency or provider throttling.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.argv.includes('--worker')) {
  const { loadAccounts } = await import('../../src/accounts')
  const { createWorkerEngine } = await import('../../src/engine/worker-client')
  const accounts = loadAccounts().accounts
  const account = accounts[0]
  if (!account || accounts.length !== 1 || account.servers.imapHost !== '127.0.0.1') throw new Error('Benchmark requires its isolated local fixture account.')
  const started = performance.now()
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  let firstThreadsMs: number | null = null
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 25)
  const engine = createWorkerEngine()
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('First sync exceeded 120 seconds')), 120_000)
      engine.subscribe((events) => {
        for (const event of events) {
          if (event.type === 'threadsChanged' && event.upserts.length && firstThreadsMs === null) firstThreadsMs = performance.now() - started
          if (event.type !== 'syncState') continue
          if (event.state.status === 'error') { clearTimeout(timeout); reject(new Error(event.state.error ?? 'Sync failed')) }
          if (event.state.status === 'idle') { clearTimeout(timeout); resolve() }
        }
      })
      engine.setAccounts(accounts)
      engine.syncNow(account.id, true)
    })
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const firstSyncMs = performance.now() - started
    const { openDatabase } = await import('../../src/engine/db')
    const db = openDatabase()
    const storedMessages = (db.query('SELECT count(*) AS count FROM messages').get() as { count: number }).count
    db.close()
    console.log(JSON.stringify({ scenario: 'local-imap-first-sync', storedMessages, firstThreadsMs: Math.round(firstThreadsMs ?? firstSyncMs), firstSyncMs: Math.round(firstSyncMs), baselineRssMiB: Math.round(baselineRss / 1048576), sampledPeakRssMiB: Math.round(peakRss / 1048576) }, null, 2))
  } finally {
    clearInterval(sampler)
    engine.dispose()
  }
  process.exit(0)
} else {
  const count = Number(process.argv[2] ?? 10000)
  if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error('Message count must be between 1 and 100000.')
  const { startFixture } = await import('./fixture')
  const directory = mkdtempSync(join(tmpdir(), 'jefi-sync-benchmark-'))
  const fixture = await startFixture(directory, { bulk: count, gmail: false })
  let exitCode = 1
  try {
    const child = Bun.spawn(['bun', import.meta.path, '--worker'], { cwd: process.cwd(), env: { ...process.env, ...fixture.env }, stdout: 'inherit', stderr: 'inherit' })
    exitCode = await child.exited
  } finally {
    await fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
  process.exit(exitCode)
}
