// ---------------------------------------------------------------------------
// Account secrets (passwords, app passwords, later OAuth refresh tokens) live in the macOS
// Keychain (src/keychain.ts, Bun.secrets), keyed by account id. They never touch accounts.json or mail.db.
// Only the engine reads them, when it opens IMAP/SMTP connections.
// ---------------------------------------------------------------------------

import { keychain } from '../keychain'

export const SECRET_SERVICE = 'app.jefi.mail/account'

export class MissingSecretError extends Error {
  readonly code = 'MISSING_SECRET'
  constructor(readonly accountId: string) {
    super(`No saved password for this account — sign in again`)
    this.name = 'MissingSecretError'
  }
}

/** Keychain refusal needs the same recovery UI as a missing credential, without leaking OS errors. */
export class SecretAccessError extends MissingSecretError {
  constructor(accountId: string) {
    super(accountId)
    this.name = 'SecretAccessError'
    this.message = "Jefi couldn't access this account's password in Keychain. Unlock your login Keychain or sign in again."
  }
}

export type SecretStore = {
  get(accountId: string): Promise<string | null>
  set(accountId: string, secret: string): Promise<void>
  delete(accountId: string): Promise<void>
}

export function keychainSecrets(service = SECRET_SERVICE): SecretStore {
  return {
    async get(accountId) {
      return keychain.get({ service, name: accountId })
    },
    async set(accountId, secret) {
      // An empty secret means "forget it", never a stored empty password.
      if (!secret) await keychain.delete({ service, name: accountId })
      else await keychain.set({ service, name: accountId, value: secret })
    },
    async delete(accountId) {
      await keychain.delete({ service, name: accountId })
    },
  }
}

/** The secret for an account, or a MissingSecretError the UI can turn into a sign-in prompt. */
export async function requireSecret(store: SecretStore, accountId: string): Promise<string> {
  let secret: string | null
  try {
    secret = await store.get(accountId)
  } catch {
    throw new SecretAccessError(accountId)
  }
  if (!secret) throw new MissingSecretError(accountId)
  return secret
}
