import { afterAll, describe, expect, test } from 'bun:test'
import { MissingSecretError, SecretAccessError, keychainSecrets, requireSecret } from './secrets'

test('a denied Keychain read requests sign-in recovery without exposing the underlying error', async () => {
  const denied = { get: async () => { throw new Error('OS error with sensitive internals') }, set: async () => {}, delete: async () => {} }
  const error = await requireSecret(denied, 'locked-account').catch((error) => error)
  expect(error).toBeInstanceOf(SecretAccessError)
  expect(error).toBeInstanceOf(MissingSecretError)
  expect(error.accountId).toBe('locked-account')
  expect(error.message).toContain('sign in again')
  expect(error.message).not.toContain('sensitive internals')
})

// Uses the real login Keychain under a test-only service name, and removes everything it writes.
// macOS only: elsewhere there's no Keychain to test (CI runs these in the release job, on a Mac).
const onMac = process.platform === 'darwin'
const service = `app.jefi.mail.test/${process.pid}`
const store = keychainSecrets(service)
const ids = ['acct-a', 'acct-b', 'acct-empty']

afterAll(async () => {
  if (onMac) for (const id of ids) await store.delete(id)
})

describe.skipIf(!onMac)('keychain secrets', () => {
  test('set, read back, and delete', async () => {
    await store.set('acct-a', 'app-pässword ✓')
    expect(await store.get('acct-a')).toBe('app-pässword ✓')
    await store.delete('acct-a')
    expect(await store.get('acct-a')).toBeNull()
  })

  test('secrets are per account and overwrite in place', async () => {
    await store.set('acct-a', 'one')
    await store.set('acct-b', 'two')
    await store.set('acct-a', 'uno')
    expect(await store.get('acct-a')).toBe('uno')
    expect(await store.get('acct-b')).toBe('two')
  })

  test('setting an empty secret removes it', async () => {
    await store.set('acct-empty', 'temporary')
    await store.set('acct-empty', '')
    expect(await store.get('acct-empty')).toBeNull()
  })

  test('deleting a missing secret is harmless', async () => {
    await expect(store.delete('never-stored')).resolves.toBeUndefined()
  })

  test('requireSecret surfaces a typed error when nothing is stored', async () => {
    const error = await requireSecret(store, 'never-stored').catch((e) => e)
    expect(error).toBeInstanceOf(MissingSecretError)
    expect(error.code).toBe('MISSING_SECRET')
    expect(error.accountId).toBe('never-stored')
    await store.set('acct-b', 'present')
    expect(await requireSecret(store, 'acct-b')).toBe('present')
  })
})
