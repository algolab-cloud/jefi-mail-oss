/**
 * Read-only check of the text-only body fetch against the whole-source parse, on real accounts.
 *   bun scripts/testing/compare-text-bodies.ts [account-id...]
 * Reads ~/.config/jefi/accounts.json and Keychain secrets (never writes either; a refreshed OAuth
 * token lives in memory only), opens mailboxes with EXAMINE, and never touches mail.db. Prints only
 * ids, UIDs, sizes, lengths and short hashes: no message content leaves this process.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { Account } from '../../src/accounts'
import { createImapClient } from '../../src/engine/connection'
import { credentialsFor } from '../../src/engine/credentials'
import type { StoredBody } from '../../src/engine/mail-store'
import { keychainSecrets, type SecretStore } from '../../src/engine/secrets'
import { fetchTextBodies, storedBody } from '../../src/engine/sync'

const LARGE = 262144
const LARGE_COUNT = 30
const SMALL_COUNT = 20

// Reads pass through; writes are dropped so the Keychain is never changed.
const keychain = keychainSecrets()
const secrets: SecretStore = {
  get: (id) => keychain.get(id),
  async set(id) { console.log(`  [${id}] refreshed token NOT persisted (read-only run)`) },
  async delete(id) { console.log(`  [${id}] secret delete ignored (read-only run)`) },
}

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex').slice(0, 8)
const len = (value: string | null) => (value == null ? 'null' : String(value.length))
const firstDiff = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

type Diff = { account: string; mailbox: string; uid: number; size: number; field: string; detail: string }
type Tally = { compared: number; identical: number; differing: number; errors: number; fellBack: number }

function compare(a: StoredBody, b: StoredBody, push: (field: string, detail: string) => void) {
  for (const field of ['text', 'html', 'snippet'] as const) {
    const x = a[field], y = b[field]
    if (x === y) continue
    const at = x != null && y != null ? ` firstDiff@${firstDiff(x, y)}` : ''
    push(field, `A len ${len(x)} #${hash(x)} / B len ${len(y)} #${hash(y)}${at}`)
  }
  if (a.attachments.length !== b.attachments.length) push('attachments.count', `A ${a.attachments.length} / B ${b.attachments.length}`)
  const n = Math.min(a.attachments.length, b.attachments.length)
  for (let i = 0; i < n; i++) {
    const x = a.attachments[i], y = b.attachments[i]
    for (const key of ['filename', 'contentType', 'contentId'] as const) {
      if ((x[key] ?? null) !== (y[key] ?? null)) push(`attachments.${key}`, `#${i} A #${hash(x[key])} / B #${hash(y[key])}`)
    }
    if (x.size !== y.size) {
      const ratio = x.size != null && y.size ? x.size / y.size : NaN
      // Estimates are expected to differ a little; only a ratio outside 0.9–1.1 counts.
      if (!(ratio >= 0.9 && ratio <= 1.1)) push('attachments.size', `#${i} A ${x.size}${x.sizeEstimated ? '~' : ''} / B ${y.size} ratio ${ratio.toFixed(3)}`)
    }
  }
  // Same multiset in a different order shows up above; say so explicitly.
  const key = (s: StoredBody) => s.attachments.map((x) => hash([x.filename, x.contentType, x.contentId]))
  const ka = key(a), kb = key(b)
  if (ka.join() !== kb.join() && [...ka].sort().join() === [...kb].sort().join()) push('attachments.order', 'same set, different order')
}

async function newestUids(client: ImapFlow) {
  const large = ((await client.search({ larger: LARGE }, { uid: true })) || []).sort((x, y) => y - x).slice(0, LARGE_COUNT)
  const all = ((await client.search({ all: true }, { uid: true })) || []).sort((x, y) => y - x)
  const sizes = new Map<number, number>()
  // Sizes of the newest few hundred, to pick small ones without a full-mailbox FETCH.
  const recent = all.slice(0, 400)
  if (recent.length) for await (const m of client.fetch(recent.join(','), { uid: true, size: true }, { uid: true })) sizes.set(m.uid, m.size ?? 0)
  const small = recent.filter((uid) => (sizes.get(uid) ?? LARGE + 1) <= LARGE).slice(0, SMALL_COUNT)
  if (large.length) for await (const m of client.fetch(large.join(','), { uid: true, size: true }, { uid: true })) sizes.set(m.uid, m.size ?? 0)
  return { uids: [...large, ...small], sizes, largeCount: large.length, smallCount: small.length }
}

async function compareMailbox(client: ImapFlow, accountId: string, path: string, diffs: Diff[], errors: string[]): Promise<Tally> {
  const tally: Tally = { compared: 0, identical: 0, differing: 0, errors: 0, fellBack: 0 }
  const lock = await client.getMailboxLock(path, { readOnly: true })
  try {
    const { uids, sizes, largeCount, smallCount } = await newestUids(client)
    console.log(`  ${path}: ${largeCount} large + ${smallCount} small`)
    const textOnly = new Map<number, StoredBody>()
    const fellBack = new Set<number>()
    // One call per message so one bad message can't hide the rest; order and grouping don't change the result.
    for (const uid of uids) {
      try {
        const whole = await fetchTextBodies(client, [uid], (u, body) => textOnly.set(u, body))
        for (const u of whole) fellBack.add(u)
      } catch (err) {
        errors.push(`${accountId} ${path} uid ${uid} text-only: ${(err as Error).message}`)
        tally.errors++
      }
    }
    for (const uid of uids) {
      const a = textOnly.get(uid)
      const push = (field: string, detail: string) => diffs.push({ account: accountId, mailbox: path, uid, size: sizes.get(uid) ?? 0, field, detail })
      if (!a) {
        if (fellBack.has(uid)) tally.fellBack++
        continue
      }
      try {
        let source: Buffer | undefined
        for await (const m of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) source = m.source
        if (!source) throw new Error('no source returned')
        const b = storedBody(await simpleParser(source))
        source = undefined
        const before = diffs.length
        compare(a, b, push)
        tally.compared++
        if (diffs.length === before) tally.identical++
        else tally.differing++
      } catch (err) {
        errors.push(`${accountId} ${path} uid ${uid} whole: ${(err as Error).message}`)
        tally.errors++
      }
    }
  } finally {
    lock.release()
  }
  return tally
}

const file = JSON.parse(readFileSync(join(homedir(), '.config/jefi/accounts.json'), 'utf8')) as { accounts: Account[] }
const only = process.argv.slice(2)
const accounts = file.accounts.filter((a) => !only.length || only.includes(a.id))
const diffs: Diff[] = []
const errors: string[] = []
const tallies: Array<{ account: string; mailbox: string } & Tally> = []

for (const account of accounts) {
  console.log(`account ${account.id}`)
  let client: ImapFlow | undefined
  try {
    client = createImapClient(account, await credentialsFor(secrets, account.id))
    await client.connect()
    const list = await client.list()
    const paths = ['INBOX', ...list.filter((b) => b.specialUse === '\\All').map((b) => b.path)]
    for (const path of paths) {
      try {
        tallies.push({ account: account.id, mailbox: path, ...(await compareMailbox(client, account.id, path, diffs, errors)) })
      } catch (err) {
        errors.push(`${account.id} ${path}: ${(err as Error).message}`)
      }
    }
  } catch (err) {
    errors.push(`${account.id}: ${(err as Error).message}`)
  } finally {
    await client?.logout().catch(() => client?.close())
  }
}

console.log('\n== per mailbox (compared / identical / differing / errors / fell back to whole source)')
for (const t of tallies) console.log(`${t.account}  ${t.mailbox}  ${t.compared} / ${t.identical} / ${t.differing} / ${t.errors} / ${t.fellBack}`)
console.log('\n== differences by field')
const byField = new Map<string, Diff[]>()
for (const d of diffs) byField.set(d.field, [...(byField.get(d.field) ?? []), d])
for (const [field, list] of byField) {
  console.log(`${field}: ${list.length}`)
  for (const d of list) console.log(`  ${d.account} ${d.mailbox} uid ${d.uid} size ${d.size}: ${d.detail}`)
}
console.log('\n== errors')
for (const e of errors) console.log(e)
