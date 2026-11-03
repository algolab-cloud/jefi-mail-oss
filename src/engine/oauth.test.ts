import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { checkImap, classify } from './connection'
import { credentialsFor, credentialsFromSecret, oauthSecret, usesOAuth } from './credentials'
import { openDatabase } from './db'
import { createImapEngine } from './imap-engine'
import { OAuthError, SIGN_IN_CANCELLED, emailFromIdToken, isSignInCancelled, refreshTokens, signIn, tokenErrorMessage } from './oauth'
import type { SecretStore } from './secrets'
import { USER, rawMessage, startImapServer } from './testing/imap-server'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  for (const key of ['JEFI_MS_CLIENT_ID', 'JEFI_MS_AUTHORIZE_URL', 'JEFI_MS_TOKEN_URL']) delete process.env[key]
})

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`

/** A stand-in for Microsoft: authorize redirects back, token issues and rotates tokens. */
async function fakeIdentityProvider(options: { failToken?: string; accessToken?: string; expiresIn?: number } = {}) {
  let issued = 0
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/authorize') {
      const redirect = `${url.searchParams.get('redirect_uri')}?code=code-1&state=${url.searchParams.get('state')}`
      res.writeHead(302, { location: redirect })
      res.end()
      return
    }
    const body = new URLSearchParams(await new Response(req as never).text())
    if (options.failToken) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: options.failToken }))
      return
    }
    issued++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        access_token: `${options.accessToken ?? 'access'}-${issued}`,
        refresh_token: body.get('grant_type') === 'refresh_token' ? `refresh-${issued}` : 'refresh-1',
        expires_in: options.expiresIn ?? 3600,
        id_token: idToken(USER.user),
      }),
    )
  })
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
  process.env.JEFI_MS_CLIENT_ID = 'test-client'
  process.env.JEFI_MS_AUTHORIZE_URL = `http://127.0.0.1:${port}/authorize`
  process.env.JEFI_MS_TOKEN_URL = `http://127.0.0.1:${port}/token`
  return { port, tokenRequests: () => issued }
}

/** Follows the authorize redirect the way a browser would. */
const browser = (url: string) => void fetch(url, { redirect: 'follow' }).catch(() => {})

describe('browser sign-in', () => {
  test('signs in, returns tokens and the address they belong to', async () => {
    await fakeIdentityProvider()
    const tokens = await signIn('microsoft', { openUrl: browser })
    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(tokens.email).toBe(USER.user)
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
  })

  test('a refused sign-in fails with the provider’s reason', async () => {
    await fakeIdentityProvider({ failToken: 'AADSTS65001: consent required' })
    const error = await signIn('microsoft', { openUrl: browser }).catch((e) => e)
    expect(error).toBeInstanceOf(OAuthError)
    expect(error.detail).toContain('consent required')
  })

  test('without a client id it says the build is not configured', async () => {
    const saved = process.env.JEFI_MS_CLIENT_ID
    process.env.JEFI_MS_CLIENT_ID = ''
    const error = await signIn('microsoft', { openUrl: browser }).catch((e) => e)
    if (saved === undefined) delete process.env.JEFI_MS_CLIENT_ID
    else process.env.JEFI_MS_CLIENT_ID = saved
    expect(error).toBeInstanceOf(OAuthError)
    expect(error.message).toMatch(/isn't configured/)
  })

  test('refreshing keeps a refresh token when the provider does not send a new one', async () => {
    await fakeIdentityProvider()
    const rotated = await refreshTokens('microsoft', 'refresh-1')
    expect(rotated.accessToken).toBe('access-1')
    expect(rotated.refreshToken).toBe('refresh-1')
  })

  test('reads the address out of an id_token, and copes with a broken one', () => {
    expect(emailFromIdToken(idToken('me@example.com'))).toBe('me@example.com')
    expect(emailFromIdToken('not-a-token')).toBeUndefined()
    expect(emailFromIdToken(undefined)).toBeUndefined()
  })
})

describe('stored credentials', () => {
  const store = (initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } => {
    const values = new Map(Object.entries(initial))
    return { values, get: async (id) => values.get(id) ?? null, set: async (id, v) => void values.set(id, v), delete: async (id) => void values.delete(id) }
  }

  test('a password account stays a password account', async () => {
    const secrets = store({ a: 'hunter2' })
    expect(await credentialsFor(secrets, 'a')).toEqual({ type: 'password', secret: 'hunter2' })
    expect(await usesOAuth(secrets, 'a')).toBe(false)
  })

  test('a valid access token is used as-is; an expiring one is refreshed and saved', async () => {
    const idp = await fakeIdentityProvider()
    const fresh = oauthSecret('microsoft', { accessToken: 'still-good', refreshToken: 'refresh-1', expiresAt: Date.now() + 600_000 })
    const secrets = store({ a: fresh })
    expect(await credentialsFor(secrets, 'a')).toEqual({ type: 'oauth', accessToken: 'still-good' })
    expect(idp.tokenRequests()).toBe(0)
    expect(await usesOAuth(secrets, 'a')).toBe(true)

    await secrets.set('a', oauthSecret('microsoft', { accessToken: 'stale', refreshToken: 'refresh-1', expiresAt: Date.now() + 5_000 }))
    expect(await credentialsFor(secrets, 'a')).toEqual({ type: 'oauth', accessToken: 'access-1' })
    expect(idp.tokenRequests()).toBe(1)
    // The rotated refresh token is kept for next time.
    expect(JSON.parse(secrets.values.get('a')!).refreshToken).toBe('refresh-1')
  })

  test('an unsaved sign-in can be checked before the account exists', async () => {
    await fakeIdentityProvider()
    const secret = oauthSecret('microsoft', { accessToken: 'token', refreshToken: 'refresh-1', expiresAt: Date.now() + 600_000 })
    expect(await credentialsFromSecret(secret)).toEqual({ type: 'oauth', accessToken: 'token' })
  })
})

test('an access token signs in to IMAP over XOAUTH2', async () => {
  const server = await startImapServer({ INBOX: [{ raw: rawMessage({ n: 1 }) }] }, { xoauth2Token: 'access-1' })
  cleanups.push(() => server.close())
  expect(await checkImap(server.account, { type: 'oauth', accessToken: 'access-1' }, { timeoutMs: 4000 })).toEqual({ ok: true })
  expect(await checkImap(server.account, { type: 'oauth', accessToken: 'wrong' }, { timeoutMs: 4000 })).toMatchObject({ ok: false, kind: 'auth' })
})

describe('sign-in failures in words', () => {
  test('cancelling a waiting sign-in rejects with the cancel the UI stays quiet about', async () => {
    await fakeIdentityProvider()
    const abort = new AbortController()
    // The browser never comes back: only the cancel ends it.
    const pending = signIn('microsoft', { openUrl: () => abort.abort(), signal: abort.signal }).catch((e) => e)
    const error = await pending
    expect(error.message).toBe(SIGN_IN_CANCELLED)
    expect(isSignInCancelled(error)).toBe(true)
    // Across the worker only the message survives.
    expect(isSignInCancelled(new Error(error.message))).toBe(true)
    expect(isSignInCancelled(new Error('Sign-in timed out — try again'))).toBe(false)
  })

  test('an unreachable token endpoint says to check the connection, not what fetch said', async () => {
    await fakeIdentityProvider()
    // A port nothing listens on.
    const closed = createServer()
    const port = await new Promise<number>((resolve) => closed.listen(0, '127.0.0.1', () => resolve((closed.address() as { port: number }).port)))
    await new Promise<void>((r) => closed.close(() => r()))
    process.env.JEFI_MS_TOKEN_URL = `http://127.0.0.1:${port}/token`
    const error = await refreshTokens('microsoft', 'refresh-1').catch((e) => e)
    expect(error).toBeInstanceOf(OAuthError)
    expect(error.message).toBe("Couldn't reach Microsoft to sign in — check your internet connection and try again")
    expect(error.detail).toBeTruthy()
  })

  test('token errors become sentences', () => {
    expect(tokenErrorMessage('Microsoft', 400, 'invalid_grant')).toBe('Microsoft sign-in has expired or was revoked — sign in again')
    expect(tokenErrorMessage('Microsoft', 400, 'consent_required')).toMatch(/organisation may need to approve/)
    expect(tokenErrorMessage('Microsoft', 503, '')).toMatch(/isn't responding right now/)
    expect(tokenErrorMessage('Microsoft', 400, 'invalid_request')).toBe('Microsoft refused the sign-in')
  })

  test("the wizard's connection check turns a failed token refresh into a sign-in problem", async () => {
    await fakeIdentityProvider({ failToken: 'AADSTS70008: The refresh token has expired' })
    const db = openDatabase(':memory:')
    const engine = createImapEngine({ database: () => db, secrets: { get: async () => null, set: async () => {}, delete: async () => {} }, wake: false, watch: false })
    cleanups.push(() => engine.dispose())
    const stale = oauthSecret('microsoft', { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000 })
    const report = await engine.checkConnection({ id: 'unsaved', name: 'Me', email: USER.user, provider: 'outlook', face: {}, servers: { imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' } }, stale)
    const failed = { ok: false, kind: 'auth', message: 'Microsoft sign-in has expired or was revoked — sign in again' }
    expect(report).toEqual({ imap: failed, smtp: failed } as never)
  })

  test("a server's unexplained refusal reads as a sentence, without response codes", () => {
    const account = { id: 'a', name: 'Me', email: 'me@example.com', provider: 'imap', face: {}, servers: { imapHost: 'imap.example.com', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecurity: 'ssl' } } as const
    expect(classify({ message: 'Command failed', responseText: '[ALERT] Mailbox is being migrated, please wait' }, 'imap', account as never).message).toBe('Incoming mail: imap.example.com said “Mailbox is being migrated, please wait”')
    expect(classify({ message: 'Command failed' }, 'imap', account as never).message).toBe('Incoming mail: imap.example.com gave an unexpected answer — try again, or check the server settings')
    expect(classify({ message: 'Command failed', serverResponseCode: 'UNAVAILABLE', responseText: '[UNAVAILABLE] Internal error 0x7f' }, 'imap', account as never).message).toBe('Incoming mail: imap.example.com is temporarily unavailable — try again in a few minutes')
    expect(classify({ message: 'x', responseCode: 421 }, 'smtp', account as never).message).toBe('Outgoing mail: smtp.example.com is temporarily unavailable — try again in a few minutes')
    expect(classify({ message: 'y'.repeat(400) }, 'smtp', account as never).message.length).toBeLessThan(220)
  })
})
