import { requireSecret, type SecretStore } from './secrets'
import { refreshTokens, type OAuthProviderId, type OAuthTokens } from './oauth'

// ---------------------------------------------------------------------------
// What an account signs in with. Password accounts keep the password in the Keychain; OAuth
// accounts keep the refresh token there and swap it for a short-lived access token when needed.
// Both live under the same Keychain entry, so removing an account still clears everything.
// ---------------------------------------------------------------------------

export type Credentials = { type: 'password'; secret: string } | { type: 'oauth'; accessToken: string }

type StoredOAuth = { kind: 'oauth'; provider: OAuthProviderId } & OAuthTokens

export const oauthSecret = (provider: OAuthProviderId, tokens: OAuthTokens) => JSON.stringify({ kind: 'oauth', provider, ...tokens } satisfies StoredOAuth)

const parse = (raw: string): StoredOAuth | null => {
  if (!raw.startsWith('{')) return null
  try {
    const value = JSON.parse(raw) as StoredOAuth
    return value?.kind === 'oauth' && value.refreshToken ? value : null
  } catch {
    return null
  }
}

/** Refresh this early, so a token never expires mid-sync. */
const EARLY_MS = 120_000

export async function credentialsFor(secrets: SecretStore, accountId: string, now = Date.now()): Promise<Credentials> {
  const raw = await requireSecret(secrets, accountId)
  const stored = parse(raw)
  if (!stored) return { type: 'password', secret: raw }

  if (stored.accessToken && stored.expiresAt - EARLY_MS > now) return { type: 'oauth', accessToken: stored.accessToken }
  const refreshed = await refreshTokens(stored.provider, stored.refreshToken)
  await secrets.set(accountId, oauthSecret(stored.provider, { ...refreshed, email: refreshed.email ?? stored.email }))
  return { type: 'oauth', accessToken: refreshed.accessToken }
}

/** Credentials from a secret that isn't stored yet (the wizard's connection check). */
export async function credentialsFromSecret(raw: string, now = Date.now()): Promise<Credentials> {
  const stored = parse(raw)
  if (!stored) return { type: 'password', secret: raw }
  if (stored.accessToken && stored.expiresAt - EARLY_MS > now) return { type: 'oauth', accessToken: stored.accessToken }
  const refreshed = await refreshTokens(stored.provider, stored.refreshToken)
  return { type: 'oauth', accessToken: refreshed.accessToken }
}

/** True when this account signs in with OAuth (the UI hides the password field). */
export async function usesOAuth(secrets: SecretStore, accountId: string) {
  const raw = await secrets.get(accountId)
  return !!raw && parse(raw) !== null
}
