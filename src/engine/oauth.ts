import { createServer, type Server } from 'node:http'

// ---------------------------------------------------------------------------
// Signing in with Microsoft, which no longer accepts passwords over IMAP. (Gmail uses app passwords:
// Google's mail scope needs a paid security review.)
// The desktop flow: open the provider in the person's browser, catch the redirect on 127.0.0.1,
// exchange the code (PKCE, no client secret), and keep the refresh token in the Keychain.
//
// The client id is registered once by whoever ships Jefi: Entra ID → App registrations → public
// client, redirect http://localhost, delegated IMAP.AccessAsUser.All, SMTP.Send, offline_access.
// Client ids aren't secrets (PKCE protects the flow), so it ships in the build; JEFI_MS_CLIENT_ID
// overrides it for testing against another registration.
// ---------------------------------------------------------------------------

export type OAuthProviderId = 'microsoft'

export type OAuthProvider = {
  id: OAuthProviderId
  label: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: string
}

/** Jefi's own Entra app registration: any work account plus personal Outlook. */
const MICROSOFT_CLIENT_ID = 'a801e48e-6db0-4d1c-aaaf-9dc5f2d728b6'

const MICROSOFT_SCOPES = [
  'offline_access',
  'openid',
  'email',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
]

export function oauthProvider(id: OAuthProviderId): OAuthProvider {
  const env = typeof process !== 'undefined' ? process.env : {}
  return {
    id,
    label: 'Microsoft',
    // "common" covers both work/school (Microsoft 365) and personal Outlook.com accounts.
    authorizeUrl: env.JEFI_MS_AUTHORIZE_URL ?? 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: env.JEFI_MS_TOKEN_URL ?? 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: MICROSOFT_SCOPES,
    clientId: env.JEFI_MS_CLIENT_ID ?? MICROSOFT_CLIENT_ID,
  }
}

export const oauthProviderFor = (provider: string): OAuthProviderId | null => (provider === 'outlook' ? 'microsoft' : null)

export type OAuthTokens = {
  accessToken: string
  refreshToken: string
  /** Epoch ms; refreshed a minute early. */
  expiresAt: number
  email?: string
}

export class OAuthError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message)
    this.name = 'OAuthError'
  }
}

/**
 * The message of a sign-in the person stopped themselves (Cancel, or closing the sign-in window).
 * Only the message crosses the worker boundary, so the UI recognises a cancel by it and says nothing.
 */
export const SIGN_IN_CANCELLED = 'Sign-in cancelled'
export const isSignInCancelled = (err: unknown) => err instanceof Error && err.message === SIGN_IN_CANCELLED

export type SignInOptions = {
  /** Opens the provider's page; defaults to the system browser. */
  openUrl?: (url: string) => void
  /** Prefill the account picker. */
  loginHint?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** The whole browser sign-in: returns tokens, or throws OAuthError if it's refused or times out. */
export async function signIn(id: OAuthProviderId, options: SignInOptions = {}): Promise<OAuthTokens> {
  const provider = oauthProvider(id)
  if (!provider.clientId) {
    throw new OAuthError(`${provider.label} sign-in isn't configured in this build`, 'Set JEFI_MS_CLIENT_ID')
  }
  const verifier = randomString(64)
  const challenge = await pkceChallenge(verifier)
  const state = randomString(24)

  const { server, port, waitForCode } = await listenForRedirect(state, options.timeoutMs ?? 5 * 60_000, options.signal)
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const authorizeUrl = `${provider.authorizeUrl}?${new URLSearchParams({
    client_id: provider.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: provider.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  })}`

  try {
    ;(options.openUrl ?? openInBrowser)(authorizeUrl)
    const code = await waitForCode
    return await exchange(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier })
  } finally {
    server.close()
  }
}

/** Swaps a refresh token for a fresh access token (providers may also rotate the refresh token). */
export async function refreshTokens(id: OAuthProviderId, refreshToken: string): Promise<OAuthTokens> {
  const provider = oauthProvider(id)
  const tokens = await exchange(provider, { grant_type: 'refresh_token', refresh_token: refreshToken })
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken }
}

async function exchange(provider: OAuthProvider, params: Record<string, string>): Promise<OAuthTokens> {
  let response: Response
  try {
    response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: provider.clientId,
        ...params,
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    // Offline, DNS, a proxy or a timeout: fetch's own words ("Unable to connect. Is the computer able
    // to access the url?") mean nothing in a mail app.
    throw new OAuthError(`Couldn't reach ${provider.label} to sign in — check your internet connection and try again`, err instanceof Error ? err.message : String(err))
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, string | number>
  if (!response.ok || !body.access_token) {
    const detail = [body.error, body.error_description].filter(Boolean).join(': ') || `HTTP ${response.status}`
    throw new OAuthError(tokenErrorMessage(provider.label, response.status, String(body.error ?? '')), detail)
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : '',
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    email: emailFromIdToken(body.id_token ? String(body.id_token) : undefined),
  }
}

/** What a failed token request means for the person, without the provider's error codes. */
export function tokenErrorMessage(label: string, status: number, error: string): string {
  if (error === 'invalid_grant') return `${label} sign-in has expired or was revoked — sign in again`
  if (error === 'consent_required' || error === 'interaction_required' || error === 'unauthorized_client') {
    return `${label} didn't allow Jefi to use this account — your organisation may need to approve it`
  }
  if (error === 'temporarily_unavailable' || status >= 500) return `${label} sign-in isn't responding right now — try again in a few minutes`
  return `${label} refused the sign-in`
}

/** The address the tokens belong to, read from the id_token the token endpoint just returned. */
export function emailFromIdToken(idToken?: string): string | undefined {
  const payload = idToken?.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, string>
    return claims.email ?? claims.preferred_username ?? claims.upn
  } catch {
    return undefined
  }
}

type Redirect = { server: Server; port: number; waitForCode: Promise<string> }

/** A one-shot local server for the provider's redirect; it answers in the browser and closes. */
function listenForRedirect(state: string, timeoutMs: number, signal?: AbortSignal): Promise<Redirect> {
  return new Promise((resolveServer, rejectServer) => {
    let settle: { resolve: (code: string) => void; reject: (error: Error) => void }
    const waitForCode = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject }
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const ok = !error && code && url.searchParams.get('state') === state
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page(ok ? 'You are signed in. You can close this page and go back to Jefi.' : 'Sign-in failed. Go back to Jefi and try again.'))
      if (ok) settle.resolve(code)
      else settle.reject(new OAuthError('Sign-in was cancelled or refused', error ?? (code ? 'state mismatch' : 'no code returned')))
    })
    server.on('error', rejectServer)

    const timer = setTimeout(() => settle.reject(new OAuthError('Sign-in timed out — try again')), timeoutMs)
    signal?.addEventListener('abort', () => settle.reject(new OAuthError(SIGN_IN_CANCELLED)))
    void waitForCode.catch(() => {}).finally(() => clearTimeout(timer))

    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: (server.address() as { port: number }).port, waitForCode }))
  })
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Jefi Mail</title><body style="font-family:-apple-system,system-ui,sans-serif;background:#141417;color:#f5f5f7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p style="font-size:15px">${message}</p></body>`

/** The default browser; JEFI_OAUTH_BROWSER (e.g. "Safari") picks one, as screen recordings of sign-in need it in front. */
export const openInBrowser = (url: string) => {
  const app = typeof process !== 'undefined' ? process.env.JEFI_OAUTH_BROWSER : undefined
  if (app === 'Safari') {
    // A fresh window at a fixed place (JEFI_OAUTH_BOUNDS "x1,y1,x2,y2"), so a recording can frame just it.
    const bounds = process.env.JEFI_OAUTH_BOUNDS ?? '160,120,1360,900'
    const script = `tell application "Safari"
      make new document with properties {URL:"${url.replace(/"/g, '%22')}"}
      set bounds of front window to {${bounds}}
      activate
    end tell`
    Bun.spawn(['osascript', '-e', script], { stdout: 'ignore', stderr: 'ignore' })
    return
  }
  Bun.spawn(app ? ['open', '-a', app, url] : ['open', url], { stdout: 'ignore', stderr: 'ignore' })
}

const randomString = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}
