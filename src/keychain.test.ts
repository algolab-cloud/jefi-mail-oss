import { afterEach, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECRET_SERVICE, keychainSecrets } from './engine/secrets'
import { startImapServer, USER } from './engine/testing/imap-server'
import { createWorkerEngine } from './engine/worker-client'
import type { EngineEvent } from './engine/types'
import { TEST_SECRETS_ENV, VAULT_KEY, fileKeychain, keychain, testSecretsFile, vaultKeychain, type Keychain } from './keychain'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
}, 20_000)

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jefi-keychain-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Any Keychain call from here on fails the test: the file store must be the only one touched. */
const forbidKeychain = () => {
  const real = Bun.secrets
  const refuse = async () => {
    throw new Error('touched the real Keychain')
  }
  ;(Bun as unknown as { secrets: unknown }).secrets = { get: refuse, set: refuse, delete: refuse }
  cleanups.push(() => void ((Bun as unknown as { secrets: unknown }).secrets = real))
}

/** Set env vars for one test, restoring the previous values afterwards. */
const withEnv = (vars: Record<string, string | undefined>) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  cleanups.push(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  })
}

test('the test secrets file is honoured only from source, with an isolated config dir', () => {
  const file = '/tmp/secrets.json'
  // A normal launch: no variables at all.
  expect(testSecretsFile({}, false)).toBeNull()
  // The variable alone isn't enough: without JEFI_CONFIG_DIR it would sit beside the real mail.db.
  expect(testSecretsFile({ [TEST_SECRETS_ENV]: file }, false)).toBeNull()
  // The compiled app people run never reads it, whatever its environment says.
  expect(testSecretsFile({ [TEST_SECRETS_ENV]: file, JEFI_CONFIG_DIR: '/tmp/cfg' }, true)).toBeNull()
  expect(testSecretsFile({ [TEST_SECRETS_ENV]: '', JEFI_CONFIG_DIR: '/tmp/cfg' }, false)).toBeNull()
  expect(testSecretsFile({ [TEST_SECRETS_ENV]: file, JEFI_CONFIG_DIR: '/tmp/cfg' }, false)).toBe(file)
}, 20_000)

test('a file keychain stores, overwrites and deletes per service and name', async () => {
  const file = join(tempDir(), 'nested', 'secrets.json')
  const store = fileKeychain(file)
  expect(await store.get({ service: 's', name: 'a' })).toBeNull()
  await store.delete({ service: 's', name: 'missing' })
  expect(existsSync(file)).toBe(false)
  await store.set({ service: 's', name: 'a', value: 'pässword ✓' })
  await store.set({ service: 's', name: 'b', value: 'two' })
  await store.set({ service: 'other', name: 'a', value: 'elsewhere' })
  await store.set({ service: 's', name: 'a', value: 'uno' })
  // A second handle (another process, the engine worker) sees the same contents.
  const again = fileKeychain(file)
  expect(await again.get({ service: 's', name: 'a' })).toBe('uno')
  expect(await again.get({ service: 'other', name: 'a' })).toBe('elsewhere')
  await again.delete({ service: 's', name: 'a' })
  expect(await store.get({ service: 's', name: 'a' })).toBeNull()
  expect(await store.get({ service: 's', name: 'b' })).toBe('two')
  expect(statSync(file).mode & 0o777).toBe(0o600)
}, 20_000)

test('with the switch set, every secret goes to the file and never the Keychain', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.json')
  withEnv({ JEFI_CONFIG_DIR: join(dir, 'config'), [TEST_SECRETS_ENV]: file })
  forbidKeychain()
  const accounts = keychainSecrets()
  await accounts.set('acct-1', 'hunter2')
  expect(await accounts.get('acct-1')).toBe('hunter2')
  await keychain.set({ service: 'app.jefi.ai', name: 'anthropic', value: 'sk-test' })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [SECRET_SERVICE]: { 'acct-1': 'hunter2' }, 'app.jefi.ai': { anthropic: 'sk-test' } })
  // An empty secret means forget it, as with the Keychain.
  await accounts.set('acct-1', '')
  expect(await accounts.get('acct-1')).toBeNull()
}, 20_000)

test('without the switch the Keychain is used', async () => {
  withEnv({ [TEST_SECRETS_ENV]: undefined })
  forbidKeychain()
  expect(await keychain.get({ service: 'x', name: 'y' }).catch((e: Error) => e.message)).toBe('touched the real Keychain')
}, 20_000)

test('the engine worker signs in with the password from the test secrets file', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.json')
  const server = await startImapServer({ INBOX: [] })
  cleanups.push(() => server.close())
  const account = { ...server.account, id: `acct-keychain-${process.pid}` }
  await fileKeychain(file).set({ service: SECRET_SERVICE, name: account.id, value: USER.pass })
  // The worker's own environment, as the fixture passes it to the app it launches.
  const engine = createWorkerEngine({ env: { ...process.env, JEFI_CONFIG_DIR: join(dir, 'config'), [TEST_SECRETS_ENV]: file } as Record<string, string> })
  cleanups.push(() => engine.dispose())
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))
  engine.setAccounts([account])
  engine.syncNow(account.id, true)
  const started = Date.now()
  while (!events.some((e) => e.type === 'connection' && e.accountId === account.id && e.status !== 'offline')) {
    if (Date.now() - started > 10_000) throw new Error(`the worker never connected: ${JSON.stringify(events)}`)
    await Bun.sleep(20)
  }
  expect(events.find((e) => e.type === 'connection' && e.accountId === account.id && e.status !== 'offline')).toMatchObject({ status: 'online' })
}, 20_000)

/** A stand-in Keychain that counts reads per item, the way macOS would prompt for each. */
const fakeKeychain = (items: Record<string, string> = {}) => {
  const reads: string[] = []
  const id = ({ service, name }: { service: string; name: string }) => `${service}/${name}`
  const store: Keychain = {
    async get(item) {
      reads.push(id(item))
      return items[id(item)] ?? null
    },
    async set(item) {
      items[id(item)] = item.value
    },
    async delete(item) {
      delete items[id(item)]
    },
  }
  return { store, items, reads }
}

test('the vault keeps every secret behind one Keychain item', async () => {
  const file = join(tempDir(), 'secrets.vault')
  const keys = fakeKeychain()
  const vault = vaultKeychain(file, keys.store)
  for (let i = 0; i < 20; i++) await vault.set({ service: 'app.jefi.mail/account', name: `acct-${i}`, value: `pw-${i}` })
  const again = vaultKeychain(file, keys.store)
  keys.reads.length = 0
  for (let i = 0; i < 20; i++) expect(await again.get({ service: 'app.jefi.mail/account', name: `acct-${i}` })).toBe(`pw-${i}`)
  // Twenty secrets, one Keychain read: the vault key.
  expect(keys.reads).toEqual([`${VAULT_KEY.service}/${VAULT_KEY.name}`])
  // Only the key is in the Keychain, and the file holds no secret in the clear.
  expect(Object.keys(keys.items)).toEqual([`${VAULT_KEY.service}/${VAULT_KEY.name}`])
  expect(readFileSync(file, 'utf8')).not.toContain('pw-1')
  expect(statSync(file).mode & 0o777).toBe(0o600)
}, 20_000)

test('a secret saved before the vault moves in on first read and is never looked up again', async () => {
  const file = join(tempDir(), 'secrets.vault')
  const keys = fakeKeychain({ 'app.jefi.mail/license/key': 'JEFI-123' })
  const vault = vaultKeychain(file, keys.store)
  const item = { service: 'app.jefi.mail/license', name: 'key' }
  expect(await vault.get(item)).toBe('JEFI-123')
  expect(await vault.get({ service: 'app.jefi.mail/ai', name: 'openai' })).toBeNull()
  keys.reads.length = 0
  expect(await vaultKeychain(file, keys.store).get(item)).toBe('JEFI-123')
  expect(await vaultKeychain(file, keys.store).get({ service: 'app.jefi.mail/ai', name: 'openai' })).toBeNull()
  expect(keys.reads.filter((read) => !read.includes(VAULT_KEY.name))).toEqual([])
  // The old item stays for an older Jefi until the secret is deleted, which clears both.
  expect(keys.items['app.jefi.mail/license/key']).toBe('JEFI-123')
  await vault.delete(item)
  expect(await vault.get(item)).toBeNull()
  expect(keys.items['app.jefi.mail/license/key']).toBeUndefined()
}, 20_000)

test('a vault whose key is gone is set aside, and secrets from before it come back', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain({ 'app.jefi.mail/account/a': 'old' })
  await vaultKeychain(file, keys.store).set({ service: 'app.jefi.mail/account', name: 'b', value: 'new' })
  delete keys.items[`${VAULT_KEY.service}/${VAULT_KEY.name}`]
  const vault = vaultKeychain(file, keys.store)
  expect(await vault.get({ service: 'app.jefi.mail/account', name: 'a' })).toBe('old')
  expect(require('node:fs').readdirSync(dir).some((name: string) => name.startsWith('secrets.vault.unreadable-'))).toBe(true)
}, 20_000)

test('saves from two handles at once keep both secrets', async () => {
  const file = join(tempDir(), 'secrets.vault')
  const keys = fakeKeychain()
  await vaultKeychain(file, keys.store).set({ service: 's', name: 'seed', value: 'x' })
  const [one, two] = [vaultKeychain(file, keys.store), vaultKeychain(file, keys.store)]
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? one : two).set({ service: 's', name: `n${i}`, value: `v${i}` })))
  const check = vaultKeychain(file, keys.store)
  for (let i = 0; i < 10; i++) expect(await check.get({ service: 's', name: `n${i}` })).toBe(`v${i}`)
}, 20_000)

test('an old item asked for by several connections at once is read from the Keychain once', async () => {
  const file = join(tempDir(), 'secrets.vault')
  const keys = fakeKeychain({ 'app.jefi.mail/account/a': 'pw' })
  const vault = vaultKeychain(file, keys.store)
  const item = { service: 'app.jefi.mail/account', name: 'a' }
  expect(await Promise.all([vault.get(item), vault.get(item), vault.get(item)])).toEqual(['pw', 'pw', 'pw'])
  expect(keys.reads.filter((read) => read === 'app.jefi.mail/account/a')).toHaveLength(1)
}, 20_000)

test('an old item the Keychain refuses is not asked for again this session', async () => {
  const file = join(tempDir(), 'secrets.vault')
  const keys = fakeKeychain()
  let asked = 0
  const refusing: Keychain = {
    ...keys.store,
    async get(item) {
      if (item.name === VAULT_KEY.name) return keys.store.get(item)
      asked++
      throw new Error('User canceled')
    },
  }
  const vault = vaultKeychain(file, refusing)
  const item = { service: 'app.jefi.mail/account', name: 'a' }
  await expect(vault.get(item)).rejects.toThrow()
  await expect(vault.get(item)).rejects.toThrow()
  expect(asked).toBe(1)
}, 20_000)

test('a worker gets the vault key from the main thread, not the Keychain', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain()
  const main = vaultKeychain(file, keys.store, { shareKey: true })
  await main.set({ service: 'app.jefi.mail/account', name: 'a', value: 'pw' })
  keys.reads.length = 0
  // The worker's own Keychain refuses everything: the only way it can read the secret is the shared key.
  const script = join(dir, 'worker.ts')
  require('node:fs').writeFileSync(script, `
    import { vaultKeychain } from ${JSON.stringify(join(import.meta.dir, 'keychain.ts'))}
    const refuse = async () => { throw new Error('worker touched the Keychain') }
    const vault = vaultKeychain(${JSON.stringify(file)}, { get: refuse, set: refuse, delete: refuse }, { shareKey: true })
    vault.get({ service: 'app.jefi.mail/account', name: 'a' }).then((value) => postMessage({ value }), (error) => postMessage({ error: String(error) }))
  `)
  const worker = new Worker(script)
  cleanups.push(() => worker.terminate())
  const reply = await new Promise<{ value?: string; error?: string }>((resolve) => (worker.onmessage = (event) => resolve(event.data)))
  expect(reply).toEqual({ value: 'pw' })
  // The main thread already had the key, so answering the worker cost no Keychain read at all.
  expect(keys.reads).toEqual([])
}, 20_000)

const KEY_ID = `${VAULT_KEY.service}/${VAULT_KEY.name}`
const quietErrors = () => {
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  cleanups.push(() => spy.mockRestore())
  return spy
}

test('a Keychain read that fails leaves the vault alone and surfaces the error', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain()
  await vaultKeychain(file, keys.store).set({ service: 's', name: 'a', value: 'kept' })
  const before = readFileSync(file)
  let sets = 0
  const failing: Keychain = {
    ...keys.store,
    async get() {
      throw new Error('User interaction is not allowed.')
    },
    async set(item) {
      sets++
      return keys.store.set(item)
    },
  }
  const vault = vaultKeychain(file, failing)
  await expect(vault.get({ service: 's', name: 'a' })).rejects.toThrow('User interaction is not allowed.')
  await expect(vault.set({ service: 's', name: 'b', value: 'x' })).rejects.toThrow()
  // Nothing set aside, rewritten or replaced: the next launch, with the Keychain unlocked, reads it all.
  expect(readFileSync(file)).toEqual(before)
  expect(readdirSync(dir).filter((name) => name.includes('unreadable') || name.includes('corrupt'))).toEqual([])
  expect(sets).toBe(0)
  expect(await vaultKeychain(file, keys.store).get({ service: 's', name: 'a' })).toBe('kept')
}, 20_000)

test('two handles making the first key at once agree on one key', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain()
  let sets = 0
  // Both handles find no key before either makes one: the race on a first launch.
  const waiting: Array<() => void> = []
  let firstReads = 0
  const racing: Keychain = {
    async get(item) {
      if (item.name === VAULT_KEY.name && firstReads < 2) {
        firstReads++
        await new Promise<void>((resolve) => {
          waiting.push(resolve)
          if (waiting.length === 2) for (const go of waiting.splice(0)) go()
        })
        return null
      }
      return keys.store.get(item)
    },
    async set(item) {
      if (item.name === VAULT_KEY.name) sets++
      return keys.store.set(item)
    },
    delete: keys.store.delete,
  }
  const [one, two] = [vaultKeychain(file, racing), vaultKeychain(file, racing)]
  await Promise.all([one.set({ service: 's', name: 'one', value: '1' }), two.set({ service: 's', name: 'two', value: '2' })])
  expect(sets).toBe(1)
  expect(readdirSync(dir).filter((name) => name.includes('unreadable') || name.includes('corrupt') || name.includes('lock'))).toEqual([])
  // Each sees the other's save, and a fresh handle (a later launch) reads both.
  expect(await one.get({ service: 's', name: 'two' })).toBe('2')
  expect(await two.get({ service: 's', name: 'one' })).toBe('1')
  const later = vaultKeychain(file, keys.store)
  expect(await later.get({ service: 's', name: 'one' })).toBe('1')
  expect(await later.get({ service: 's', name: 'two' })).toBe('2')
}, 20_000)

test('a damaged vault is kept aside under a timestamped name and Jefi starts over', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain({ 'app.jefi.mail/account/a': 'from-before-the-vault' })
  await vaultKeychain(file, keys.store).set({ service: 's', name: 'x', value: 'lost' })
  const damaged = '{"iv":"AAAA","tag":"AAAA","data":"trunc'
  writeFileSync(file, damaged)
  const errors = quietErrors()
  const vault = vaultKeychain(file, keys.store)
  // Reads work again: a secret from before the vault comes back from its own Keychain item.
  expect(await vault.get({ service: 'app.jefi.mail/account', name: 'a' })).toBe('from-before-the-vault')
  expect(await vault.get({ service: 's', name: 'x' })).toBeNull()
  const aside = readdirSync(dir).filter((name) => /^secrets\.vault\.corrupt-\d+$/.test(name))
  expect(aside).toHaveLength(1)
  expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe(damaged)
  expect(errors).toHaveBeenCalledTimes(1)
  expect(String(errors.mock.calls[0]![0])).toContain('corrupt-')
  await vault.set({ service: 's', name: 'y', value: 'new' })
  expect(await vaultKeychain(file, keys.store).get({ service: 's', name: 'y' })).toBe('new')
}, 20_000)

test('a vault sealed under another key is kept aside too, not failed on forever', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain()
  await vaultKeychain(file, keys.store).set({ service: 's', name: 'x', value: 'old key' })
  keys.items[KEY_ID] = Buffer.alloc(32, 7).toString('base64')
  quietErrors()
  const vault = vaultKeychain(file, keys.store)
  expect(await vault.get({ service: 's', name: 'x' })).toBeNull()
  await vault.set({ service: 's', name: 'x', value: 'new key' })
  expect(await vault.get({ service: 's', name: 'x' })).toBe('new key')
  expect(readdirSync(dir).filter((name) => name.startsWith('secrets.vault.corrupt-'))).toHaveLength(1)
}, 20_000)

test('a vault file that cannot be read is an error, and is left where it is', async () => {
  if (process.getuid?.() === 0) return // root reads it anyway
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain()
  await vaultKeychain(file, keys.store).set({ service: 's', name: 'x', value: 'kept' })
  chmodSync(file, 0o000)
  cleanups.push(() => chmodSync(file, 0o600))
  await expect(vaultKeychain(file, keys.store).get({ service: 's', name: 'x' })).rejects.toThrow()
  expect(readdirSync(dir).filter((name) => name.includes('corrupt'))).toEqual([])
}, 20_000)

test('a malformed vault key is an error and replaces nothing', async () => {
  const dir = tempDir()
  const file = join(dir, 'secrets.vault')
  const keys = fakeKeychain()
  await vaultKeychain(file, keys.store).set({ service: 's', name: 'x', value: 'kept' })
  const before = readFileSync(file)
  const good = keys.items[KEY_ID]!
  keys.items[KEY_ID] = Buffer.from('short').toString('base64')
  await expect(vaultKeychain(file, keys.store).get({ service: 's', name: 'x' })).rejects.toThrow('malformed')
  expect(keys.items[KEY_ID]).toBe(Buffer.from('short').toString('base64'))
  expect(readFileSync(file)).toEqual(before)
  keys.items[KEY_ID] = good
  expect(await vaultKeychain(file, keys.store).get({ service: 's', name: 'x' })).toBe('kept')
}, 20_000)
