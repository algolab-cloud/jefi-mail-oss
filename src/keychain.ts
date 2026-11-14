import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configDir } from './paths'

// ---------------------------------------------------------------------------
// Every secret in Jefi (account passwords, AI keys, the Web Risk key) goes through
// `keychain`: an encrypted vault whose one key is in the Keychain (Bun.secrets; see below). Automation (scripts/testing/fixture.ts) needs
// the app it launches, and its engine worker, to never touch the real login Keychain, so a run from
// source can point JEFI_TEST_SECRETS_FILE at a JSON file instead. The switch is ignored by the
// compiled app people run, and without an isolated JEFI_CONFIG_DIR, so a normal launch can't use it.
// ---------------------------------------------------------------------------

export type KeychainItem = { service: string; name: string }
export type Keychain = {
  get(item: KeychainItem): Promise<string | null>
  set(item: KeychainItem & { value: string }): Promise<void>
  delete(item: KeychainItem): Promise<void>
}

export const TEST_SECRETS_ENV = 'JEFI_TEST_SECRETS_FILE'

/** True inside a `bun build --compile` binary, whose modules live under $bunfs. */
const compiled = () => import.meta.url.includes('$bunfs')

/**
 * The test secrets file to use instead of the Keychain, or null (the Keychain). Honoured only when
 * running from source with an isolated config directory: the shipped app never reads it.
 */
export function testSecretsFile(env: Record<string, string | undefined> = process.env, isCompiled = compiled()): string | null {
  const file = env[TEST_SECRETS_ENV]
  if (!file || isCompiled || !env.JEFI_CONFIG_DIR) return null
  return file
}

type Contents = Record<string, Record<string, string>>

const read = (file: string): Contents => {
  if (!existsSync(file)) return {}
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  return parsed && typeof parsed === 'object' ? (parsed as Contents) : {}
}

/**
 * Secrets in a JSON file ({ service: { name: value } }), read on every call so the UI process and
 * the engine worker see each other's writes. Written atomically; test use only.
 */
export function fileKeychain(file: string): Keychain {
  const write = (contents: Contents) => {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(temp, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }
  return {
    async get({ service, name }) {
      return read(file)[service]?.[name] || null
    },
    async set({ service, name, value }) {
      const contents = read(file)
      contents[service] = { ...contents[service], [name]: value }
      write(contents)
    },
    async delete({ service, name }) {
      const contents = read(file)
      if (!contents[service] || !(name in contents[service])) return
      delete contents[service][name]
      write(contents)
    },
  }
}

const bunKeychain: Keychain = {
  get: async (item) => {
    // From source, say which item is read: each read of an item this build isn't trusted with is a prompt.
    if (!compiled()) console.log(`keychain: read ${item.service} ${item.name}${Bun.isMainThread ? '' : ' (worker)'}`)
    return (await Bun.secrets.get(item)) || null
  },
  set: async (item) => void (await Bun.secrets.set(item)),
  delete: async (item) => void (await Bun.secrets.delete(item)),
}

// ---------------------------------------------------------------------------
// The vault: every secret in one file, sealed with AES-256-GCM under a single key that lives in the
// Keychain. macOS asks once per Keychain item an app reads, so twenty items meant twenty prompts;
// now there is one. Secrets saved before the vault are read from their old Keychain items the first
// time they're asked for and copied in; those items are left alone, so an older Jefi still works.
// ---------------------------------------------------------------------------

export const VAULT_KEY: KeychainItem = { service: 'app.jefi.mail', name: 'vault-key' }
const VAULT_AAD = Buffer.from('jefi-vault-1')
/** After a refused or failed key read, wait this long before asking the Keychain again. */
const KEY_RETRY_MS = 30_000

type VaultContents = { secrets: Contents; checked: string[] }
const itemId = ({ service, name }: KeychainItem) => `${service}\n${name}`

/**
 * Secrets in an encrypted file whose key is the one Keychain item `keychain` holds. Read on every
 * call, like the file store, so the UI and the engine worker see each other's writes.
 */
export function vaultKeychain(file: string, keychain: Keychain, options: { shareKey?: boolean } = {}): Keychain {
  let key: Promise<Buffer> | null = null
  let failedAt = 0

  /** The key as stored, or an error: a key that isn't 32 bytes is never used, and never replaced. */
  const decodeKey = (stored: string): Buffer => {
    const secret = Buffer.from(stored, 'base64')
    if (secret.length !== 32) throw new Error('The vault key in the Keychain is malformed')
    return secret
  }
  // The Keychain contract: get resolves null only when the item isn't there; a refused, cancelled or
  // failed read rejects. So only a key that's truly gone can set the vault aside or make a new key;
  // a read that fails just fails (vaultKey waits a while before asking again) and touches nothing.
  const loadKey = async (): Promise<Buffer> => {
    const stored = await keychain.get(VAULT_KEY)
    if (stored) return decodeKey(stored)
    return createKey()
  }
  /**
   * The first launch makes the key. The UI, the engine worker or a script beside them can all get
   * here at once, so it's made under a lock file and looked for again inside it: the first one makes
   * the key, and the rest read that one rather than replacing it (and setting its vault aside).
   */
  const createKey = async (): Promise<Buffer> => {
    mkdirSync(dirname(file), { recursive: true })
    const lock = `${file}.key-lock`
    for (let waited = 0; ; waited += 20) {
      try {
        closeSync(openSync(lock, 'wx', 0o600))
        break
      } catch {
        // Left by a crash; making a key takes well under a second, but a Keychain prompt may be up.
        if (waited > 15_000) rmSync(lock, { force: true })
        await Bun.sleep(20)
      }
    }
    try {
      const made = await keychain.get(VAULT_KEY)
      if (made) return decodeKey(made)
      // A vault without its key can't be opened again; set it aside rather than overwrite it. The
      // old Keychain items are still there, so secrets saved before the vault come back.
      if (existsSync(file)) {
        const aside = `${file}.unreadable-${Date.now()}`
        renameSync(file, aside)
        console.error(`keychain: the vault key is gone from the Keychain; set the vault aside as ${aside}`)
      }
      await keychain.set({ ...VAULT_KEY, value: randomBytes(32).toString('base64') })
      const stored = await keychain.get(VAULT_KEY)
      if (!stored) throw new Error("The Keychain didn't keep the new vault key")
      return decodeKey(stored)
    } finally {
      rmSync(lock, { force: true })
    }
  }
  const fetchKey = options.shareKey ? sharedKey(file, () => vaultKey(), loadKey) : loadKey
  const vaultKey = (): Promise<Buffer> => {
    if (!key && Date.now() - failedAt < KEY_RETRY_MS) return Promise.reject(new Error('The Keychain refused the vault key'))
    key ??= fetchKey().catch((error) => {
      key = null
      failedAt = Date.now()
      throw error
    })
    return key
  }

  const open = (raw: string, secret: Buffer): VaultContents => {
    const sealed = JSON.parse(raw) as { iv: string; tag: string; data: string }
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(VAULT_AAD)
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()])
    const contents = JSON.parse(plain.toString('utf8')) as Partial<VaultContents> | null
    if (!contents || typeof contents.secrets !== 'object' || !contents.secrets || !Array.isArray(contents.checked)) throw new Error('unexpected contents')
    return contents as VaultContents
  }
  /**
   * The vault's contents. One that can't be opened (damaged, or sealed under another key) would fail
   * every read forever, so it's kept beside the vault under a timestamped name and Jefi starts over
   * with an empty one: secrets from before the vault come back from their own Keychain items, and the
   * rest are asked for again. A file that can't be read at all (permissions, I/O) is an error, not this.
   */
  const read = (secret: Buffer, locked = false): VaultContents => {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { secrets: {}, checked: [] }
      throw error
    }
    try {
      return open(raw, secret)
    } catch (error) {
      const setAside = () => {
        // Another handle may have set it aside and written a good one meanwhile: leave that alone.
        if (!existsSync(file) || readFileSync(file, 'utf8') !== raw) return
        const aside = `${file}.corrupt-${Date.now()}`
        renameSync(file, aside)
        console.error(`keychain: the vault couldn't be opened (${error instanceof Error ? error.message : String(error)}); kept as ${aside}, starting a new one`)
      }
      if (locked) setAside()
      else withLock(setAside)
      return { secrets: {}, checked: [] }
    }
  }
  const write = (secret: Buffer, contents: VaultContents) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secret, iv)
    cipher.setAAD(VAULT_AAD)
    const data = Buffer.concat([cipher.update(JSON.stringify(contents), 'utf8'), cipher.final()])
    const sealed = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(temp, `${JSON.stringify(sealed)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }
  /** Runs `work` synchronously under the vault's lock file, so no other handle reads or writes meanwhile. */
  const withLock = (work: () => void) => {
    mkdirSync(dirname(file), { recursive: true })
    const lock = `${file}.lock`
    for (let waited = 0; ; waited += 5) {
      try {
        closeSync(openSync(lock, 'wx'))
        break
      } catch {
        // A lock left by a crash is broken after a few seconds; normally it lasts microseconds.
        if (waited > 3000) rmSync(lock, { force: true })
        Bun.sleepSync(5)
      }
    }
    try {
      work()
    } finally {
      rmSync(lock, { force: true })
    }
  }
  /**
   * Read, change and write the vault with no gap: synchronous, under a lock file, so a save from
   * the UI and one from the engine worker can't drop each other's secret.
   */
  const change = async (edit: (contents: VaultContents) => void) => {
    const secret = await vaultKey()
    withLock(() => {
      const contents = read(secret, true)
      edit(contents)
      write(secret, contents)
    })
  }
  const markChecked = (contents: VaultContents, item: KeychainItem) => {
    if (!contents.checked.includes(itemId(item))) contents.checked.push(itemId(item))
  }

  // Each old item costs one Keychain prompt, so it's read once: requests that arrive while it's being
  // read (the engine opens several connections per account) share that read, and one refused this
  // session isn't asked for again until the next launch.
  const moving = new Map<string, Promise<string | null>>()
  const refused = new Set<string>()
  const moveIn = (item: KeychainItem) => {
    const id = itemId(item)
    let pending = moving.get(id)
    if (!pending) {
      pending = (async () => {
        if (refused.has(id)) throw new Error('The Keychain refused this item')
        let legacy: string | null
        try {
          legacy = await keychain.get(item)
        } catch (error) {
          refused.add(id)
          throw error
        }
        await change((latest) => {
          if (legacy && !latest.secrets[item.service]?.[item.name]) latest.secrets[item.service] = { ...latest.secrets[item.service], [item.name]: legacy }
          markChecked(latest, item)
        })
        return legacy
      })().finally(() => moving.delete(id))
      moving.set(id, pending)
    }
    return pending
  }

  return {
    async get(item) {
      const contents = read(await vaultKey())
      const value = contents.secrets[item.service]?.[item.name]
      if (value) return value
      if (contents.checked.includes(itemId(item))) return null
      // Not looked for yet: a secret from before the vault may still be in its own Keychain item.
      return moveIn(item)
    },
    async set({ service, name, value }) {
      await change((contents) => {
        contents.secrets[service] = { ...contents.secrets[service], [name]: value }
        markChecked(contents, { service, name })
      })
    },
    async delete(item) {
      await change((contents) => {
        if (contents.secrets[item.service]) delete contents.secrets[item.service][item.name]
        markChecked(contents, item)
      })
      // Forgetting a secret (removing an account) also clears any copy saved before the vault.
      await keychain.delete(item).catch(() => {})
    },
  }
}

/**
 * The vault key for this thread. The main thread reads the Keychain and answers the others (the
 * engine worker) over a BroadcastChannel, which never leaves the process, so one launch reads the
 * key once rather than once per thread, and macOS asks at most once. A worker nobody answers within
 * a moment (no main-thread vault, as in a script) reads the Keychain itself.
 */
function sharedKey(file: string, mainKey: () => Promise<Buffer>, readKey: () => Promise<Buffer>): () => Promise<Buffer> {
  const name = `jefi-vault-key:${file}`
  if (Bun.isMainThread) {
    const channel = new BroadcastChannel(name)
    ;(channel as BroadcastChannel & { unref?: () => void }).unref?.()
    channel.onmessage = async ({ data }: MessageEvent<{ ask?: string }>) => {
      if (!data?.ask) return
      channel.postMessage({ ack: data.ask })
      try {
        channel.postMessage({ to: data.ask, key: (await mainKey()).toString('base64') })
      } catch (error) {
        channel.postMessage({ to: data.ask, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return readKey
  }
  return () =>
    new Promise<Buffer>((resolve, reject) => {
      const ask = randomBytes(8).toString('hex')
      const channel = new BroadcastChannel(name)
      let answered = false
      const unanswered = setTimeout(() => {
        if (answered) return
        channel.close()
        readKey().then(resolve, reject)
      }, 1500)
      channel.onmessage = ({ data }: MessageEvent<{ ack?: string; to?: string; key?: string; error?: string }>) => {
        if (data?.ack === ask) answered = true
        if (data?.to !== ask) return
        clearTimeout(unanswered)
        channel.close()
        if (data.key) resolve(Buffer.from(data.key, 'base64'))
        else reject(new Error(data.error ?? 'The vault key is unavailable'))
      }
      channel.postMessage({ ask })
    })
}

const vaults = new Map<string, Keychain>()
/** The vault beside accounts.json and mail.db: one per file, its key read once for the whole app. */
const vaultFor = (dir: string) => {
  const file = `${dir}/secrets.vault`
  let vault = vaults.get(file)
  if (!vault) vaults.set(file, (vault = vaultKeychain(file, bunKeychain, { shareKey: true })))
  return vault
}

// Chosen per call, so a script that sets the env before starting the engine inline still gets it.
// `bun test` keeps the plain Keychain calls it always had (tests stub Bun.secrets or use the file).
const backend = (): Keychain => {
  const file = testSecretsFile()
  if (file) return fileKeychain(file)
  const dir = process.env.NODE_ENV === 'test' ? null : configDir()
  return dir ? vaultFor(dir) : bunKeychain
}

// The main thread opens its vault as soon as this loads, so it's listening before a worker asks for the key.
if (Bun.isMainThread && process.env.NODE_ENV !== 'test' && !testSecretsFile() && configDir()) vaultFor(configDir()!)

export const keychain: Keychain = {
  get: (item) => backend().get(item),
  set: (item) => backend().set(item),
  delete: (item) => backend().delete(item),
}
