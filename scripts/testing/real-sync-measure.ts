/**
 * Measures a real first sync of one live account through the real engine, in its own process.
 *   bun scripts/testing/real-sync-measure.ts <account-id> [max-minutes=40]
 *
 * Safety rules (hard):
 * - Runs against a temporary JEFI_CONFIG_DIR holding a filtered copy of ~/.config/jefi/accounts.json
 *   with only the account under test. ~/.config/jefi/mail.db and settings are never opened; the temp
 *   dir (which fills with downloaded mail) is deleted at the end, even on failure.
 * - Secrets: Keychain reads pass through, set/delete are no-ops, so a refreshed OAuth token is never
 *   persisted and the Keychain never changes.
 * - Read-only on the server: a fresh first sync has no pending ops, drafts or outbox, so it only
 *   reads. As a guard every ImapFlow write method (APPEND, STORE, COPY, MOVE, EXPUNGE, mailbox
 *   create/delete/rename/subscribe) is replaced before the engine loads; any call throws and the
 *   run aborts with a non-zero exit.
 * - Connections: the engine's own sync and backfill connections only; push (IDLE) is off, since
 *   it plays no part in a first sync.
 * Prints only counts, timings and sizes: no message content leaves the process.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.argv.includes('--worker')) {
  const dir = process.env.JEFI_CONFIG_DIR
  if (!dir || !dir.startsWith(tmpdir()) && !dir.startsWith('/tmp/')) throw new Error('Worker needs a temporary JEFI_CONFIG_DIR.')
  const maxMs = Number(process.env.MEASURE_MAX_MINUTES ?? 40) * 60_000

  // Guard every write before any engine code can hold a client.
  const { ImapFlow } = await import('imapflow')
  const writes = ['append', 'messageFlagsAdd', 'messageFlagsRemove', 'messageFlagsSet', 'setFlagColor', 'messageDelete', 'messageCopy', 'messageMove', 'mailboxCreate', 'mailboxDelete', 'mailboxRename', 'mailboxSubscribe', 'mailboxUnsubscribe'] as const
  let blocked: string | null = null
  let connections = 0
  const proto = ImapFlow.prototype as unknown as Record<string, unknown>
  for (const name of writes) {
    proto[name] = async () => {
      blocked ??= name
      throw new Error(`read-only measurement: ${name} blocked`)
    }
  }
  const connect = proto.connect as (this: unknown) => Promise<void>
  proto.connect = function (this: unknown) { connections++; return connect.call(this) }

  const { loadAccounts } = await import('../../src/accounts')
  const { createImapEngine } = await import('../../src/engine/imap-engine')
  const { openDatabase, defaultDatabasePath } = await import('../../src/engine/db')
  const { keychainSecrets } = await import('../../src/engine/secrets')
  const keychain = keychainSecrets()
  const secrets = { get: (id: string) => keychain.get(id), async set() {}, async delete() {} }

  const accounts = loadAccounts().accounts
  const account = accounts[0]
  if (!account || accounts.length !== 1) throw new Error('Expected exactly one account in the temp config.')

  const started = performance.now()
  const cpuStart = process.cpuUsage()
  const mib = (n: number) => Math.round(n / 1048576)
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 100)
  const elapsed = () => performance.now() - started
  const cpuPct = () => { const u = process.cpuUsage(cpuStart); return Math.round(((u.user + u.system) / 1000 / elapsed()) * 100) }

  let firstThreadsMs: number | null = null
  let headersMs: number | null = null
  let syncError: string | null = null
  let headersCpu = 0, headersPeak = 0
  const engine = createImapEngine({ secrets, watch: false })
  engine.subscribe((events) => {
    for (const event of events) {
      if (event.type === 'threadsChanged' && event.upserts.length && firstThreadsMs === null) firstThreadsMs = elapsed()
      if (event.type !== 'syncState' || event.accountId !== account.id) continue
      if (event.state.status === 'error') syncError = event.state.error ?? 'sync failed'
      if (event.state.status === 'idle' && headersMs === null) { headersMs = elapsed(); headersCpu = cpuPct(); headersPeak = peakRss }
    }
  })
  // A second read-only-in-spirit handle for counting; WAL lets it read while the engine writes.
  const db = openDatabase(defaultDatabasePath())
  const count = (sql: string) => (db.query(sql).get() as { n: number }).n
  const samples: Array<{ s: number; messages: number; bodies: number; rssMiB: number }> = []
  let bodiesAt10: number | null = null
  let bodiesDoneMs: number | null = null
  let bodiesAtHeaders = 0

  engine.setAccounts(accounts)
  engine.syncNow(account.id, true)
  try {
    let lastBodies = -1, stalledSince = 0
    while (elapsed() < maxMs) {
      await Bun.sleep(5000)
      if (blocked) throw new Error(`write attempted: ${blocked}`)
      if (syncError && headersMs === null) throw new Error(`sync error: ${syncError}`)
      const messages = count('SELECT count(*) AS n FROM messages')
      const bodies = count('SELECT count(*) AS n FROM bodies')
      samples.push({ s: Math.round(elapsed() / 1000), messages, bodies, rssMiB: mib(process.memoryUsage().rss) })
      const last = samples.at(-1)!
      if (samples.length % 6 === 0) console.error(`t=${last.s}s messages=${messages} bodies=${bodies} rss=${last.rssMiB}MiB peak=${mib(peakRss)}MiB cpu=${cpuPct()}% conns=${connections}`)
      if (bodiesAt10 === null && elapsed() >= 600_000) bodiesAt10 = bodies
      if (headersMs !== null && !bodiesAtHeaders) bodiesAtHeaders = bodies || 1
      if (headersMs === null) continue
      if (bodies >= messages) { bodiesDoneMs = elapsed(); break }
      // Bodies that keep failing are left alone by the engine; a minute without progress means done.
      if (bodies !== lastBodies) { lastBodies = bodies; stalledSince = elapsed() }
      else if (elapsed() - stalledSince > 60_000) { bodiesDoneMs = stalledSince; break }
    }
    const settledRss = process.memoryUsage().rss
    const messages = count('SELECT count(*) AS n FROM messages')
    const bodies = count('SELECT count(*) AS n FROM bodies')
    const perFolder = db.query(`SELECT mb.path AS path, count(*) AS n FROM message_mailboxes mm JOIN mailboxes mb ON mb.id = mm.mailbox_id GROUP BY mb.id ORDER BY n DESC`).all()
    db.close()
    engine.dispose()
    clearInterval(sampler)
    await Bun.sleep(500)
    const path = defaultDatabasePath()
    const size = (p: string) => (existsSync(p) ? statSync(p).size : 0)
    const dbBytes = size(path) + size(`${path}-wal`)
    const headersS = (headersMs ?? elapsed()) / 1000
    const bodyWindowS = ((bodiesDoneMs ?? elapsed()) - (headersMs ?? 0)) / 1000
    console.log(JSON.stringify({
      scenario: 'real-first-sync', account: account.id, provider: account.provider,
      messages, bodies, perFolder,
      firstThreadsMs: firstThreadsMs && Math.round(firstThreadsMs), headersCompleteMs: headersMs && Math.round(headersMs),
      headersPerSecond: Math.round(messages / headersS),
      bodiesCompleteMs: bodiesDoneMs && Math.round(bodiesDoneMs), bodiesAt10Min: bodiesAt10,
      bodiesPerSecondAfterHeaders: bodyWindowS > 0 ? Math.round(((bodies - bodiesAtHeaders) / bodyWindowS) * 10) / 10 : null,
      baselineRssMiB: mib(baselineRss), peakRssDuringHeadersMiB: mib(headersPeak), peakRssMiB: mib(peakRss), settledRssMiB: mib(settledRss),
      cpuPctDuringHeaders: headersCpu, cpuPctOverall: cpuPct(), dbMiB: Math.round((dbBytes / 1048576) * 10) / 10,
      imapConnections: connections, writesBlocked: blocked, timedOut: bodiesDoneMs === null,
    }, null, 2))
    console.error(JSON.stringify(samples))
  } finally {
    clearInterval(sampler)
  }
  process.exit(blocked ? 2 : 0)
} else {
  const id = process.argv[2]
  if (!id) throw new Error('usage: bun scripts/testing/real-sync-measure.ts <account-id> [max-minutes]')
  const file = JSON.parse(readFileSync(join(homedir(), '.config/jefi/accounts.json'), 'utf8')) as { accounts: Array<{ id: string }> }
  const account = file.accounts.find((a) => a.id === id)
  if (!account) throw new Error(`No account ${id}`)
  const directory = mkdtempSync(join(tmpdir(), 'jefi-real-sync-'))
  let exitCode = 1
  try {
    writeFileSync(join(directory, 'accounts.json'), JSON.stringify({ accounts: [account], activeId: account.id }, null, 2))
    const child = Bun.spawn(['bun', import.meta.path, '--worker'], {
      cwd: process.cwd(),
      env: { ...process.env, JEFI_CONFIG_DIR: directory, MEASURE_MAX_MINUTES: process.argv[3] ?? '40' },
      stdout: 'inherit', stderr: 'inherit',
    })
    exitCode = await child.exited
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  process.exit(exitCode)
}
