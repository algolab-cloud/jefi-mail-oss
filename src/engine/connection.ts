import { isIP } from 'node:net'
import { ImapFlow, type ImapFlowOptions, type MessageRangeOptions, type SearchObject, type StoreOptions } from 'imapflow'
import nodemailer from 'nodemailer'
import type { Account } from '../accounts'
import type { Credentials } from './credentials'

// ---------------------------------------------------------------------------
// Opening IMAP/SMTP connections for an account, and the connection check the account wizard runs.
// Failures are classified so the UI can say what to fix (password vs server vs network).
// ---------------------------------------------------------------------------

export type ConnectionFailure = 'auth' | 'tls' | 'host' | 'refused' | 'timeout' | 'network' | 'protocol'

export type CheckResult = { ok: true } | { ok: false; kind: ConnectionFailure; message: string }

export type ConnectionReport = { imap: CheckResult; smtp: CheckResult }

export type ConnectOptions = {
  timeoutMs?: number
  /** Tests only: accept self-signed certificates. */
  allowInvalidCerts?: boolean
  /** PEM certificate(s) to trust instead of the system roots (test servers). */
  ca?: string
}

/**
 * Connection options for the running app. JEFI_TEST_CA_FILE lets automation trust one test
 * server's certificate without switching verification off.
 */
export function appConnectOptions(): ConnectOptions {
  const file = typeof process !== 'undefined' ? process.env.JEFI_TEST_CA_FILE : undefined
  return file ? { ca: require('node:fs').readFileSync(file, 'utf8') } : {}
}

const tlsOptions = (options: ConnectOptions) =>
  options.allowInvalidCerts ? { rejectUnauthorized: false } : options.ca ? { ca: options.ca } : undefined

const DEFAULT_TIMEOUT_MS = 15_000

export type Secret = string | Credentials

const authFor = (account: Account, secret: Secret) => {
  const credentials: Credentials = typeof secret === 'string' ? { type: 'password', secret } : secret
  return credentials.type === 'oauth' ? { user: account.email, accessToken: credentials.accessToken } : { user: account.email, pass: credentials.secret }
}

export function createImapClient(account: Account, secret: Secret, options: ConnectOptions = {}): ImapFlow {
  const { imapHost: host, imapPort: port, imapSecurity } = account.servers
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const config: ImapFlowOptions = {
    host,
    port,
    secure: imapSecurity === 'ssl',
    doSTARTTLS: imapSecurity === 'starttls' ? true : imapSecurity === 'none' ? false : undefined,
    auth: authFor(account, secret),
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: 5 * 60_000,
    // Re-issue IDLE before common NAT/proxy idle cutoffs silently drop the connection.
    maxIdleTime: 4 * 60_000,
    tls: tlsOptions(options),
    // ENABLE QRESYNC where offered, so a folder sync can ask for just what changed (see resyncSince).
    // Once on, the server reports deletions as VANISHED by UID on every connection, not EXPUNGE.
    qresync: true,
  }
  const client = new ImapFlow(config)
  // imapflow lowers the message count for an EXPUNGE but not for its QRESYNC stand-in, a live
  // VANISHED; left high, the next EXISTS could match it and a new message would go unannounced.
  client.on('expunge', (event: { path: string; vanished?: boolean; earlier?: boolean; uid?: number }) => {
    const mailbox = client.mailbox
    if (event.vanished && !event.earlier && event.uid && mailbox && mailbox.path === event.path && mailbox.exists > 0) mailbox.exists--
  })
  // imapflow uses servername:false to skip SNI for IP hosts; Node accepts that but Bun's tls throws
  // "servername argument must be an string". An absent servername means the same thing to both.
  if (isIP(host)) (client as unknown as { servername?: string }).servername = undefined
  return client
}

/**
 * client.search() returns `false` on any failure — connection not SELECTED, a NO/BAD, a timeout —
 * instead of throwing (see node_modules/imapflow/dist/esm/commands/search.js). A caller that treats
 * that the same as "no matches" turns a dropped connection into "nothing is here": exactly how a sync
 * once unlinked a whole folder locally (lume-75z.7). Anything that deletes, unlinks, or advances a
 * checkpoint from a search result should go through this instead of client.search() directly.
 */
export async function searchUids(client: ImapFlow, query: SearchObject, options: MessageRangeOptions = { uid: true }): Promise<number[]> {
  const result = await client.search(query, options)
  if (!Array.isArray(result)) throw new Error(`IMAP search failed for ${JSON.stringify(query)} (dropped connection, or a NO/BAD from the server)`)
  return result
}

// The same for the commands that change mail. messageMove, messageDelete, messageFlagsAdd/Remove and
// append answer a NO/BAD, or a connection that dropped mid-command, with `false` instead of throwing
// (node_modules/imapflow/dist/esm/commands/{move,expunge,store,append}.js). Taken as success, a
// refused change is forgotten and the message comes back on the next sync. These throw instead, so
// the caller's retry path sees it. Only `false` is a failure: `undefined` (nothing to do, e.g. an
// empty range) still resolves. The message deliberately doesn't say "connection": whether the
// connection is still usable is for the caller to judge (client.usable), not this text.
const refused = (command: string, range: unknown, where: string) => {
  const uids = String(range)
  return new Error(`IMAP ${command} of ${uids.length > 60 ? `${uids.slice(0, 60)}…` : uids} in ${where} was refused or did not complete`)
}
const selected = (client: ImapFlow) => (client.mailbox ? client.mailbox.path : 'no mailbox')

export async function moveMessages(client: ImapFlow, range: string, destination: string, options: MessageRangeOptions = { uid: true }) {
  // Without MOVE imapflow copies and then calls its own messageDelete, a plain EXPUNGE without
  // UIDPLUS (see deleteMessages). Do the same steps here so the delete takes the safe path.
  if (!client.capabilities.has('MOVE')) {
    const copied = await client.messageCopy(range, destination, options)
    if (copied === false) throw refused(`COPY to ${destination}`, range, selected(client))
    if (!copied) return copied
    await deleteMessages(client, range, options)
    return copied
  }
  const result = await client.messageMove(range, destination, options)
  if (result === false) throw refused(`MOVE to ${destination}`, range, selected(client))
  return result
}

/**
 * Delete messages from the selected folder. With UIDPLUS that's \Deleted plus UID EXPUNGE of exactly
 * these UIDs. Without it imapflow would fall back to a plain EXPUNGE, which also erases every message
 * another mail app has marked \Deleted in the folder and not expunged yet (an "undo delete" it still
 * offers, say). Not worth that risk: they're only marked \Deleted, the expunge is left to the server
 * or a client that can do it safely, and sync treats a message marked \Deleted as gone.
 */
export async function deleteMessages(client: ImapFlow, range: string, options: MessageRangeOptions = { uid: true }) {
  if (!client.capabilities.has('UIDPLUS')) {
    await addFlags(client, range, ['\\Deleted'], { uid: !!options.uid })
    return true
  }
  const result = await client.messageDelete(range, options)
  if (result === false) throw refused('delete', range, selected(client))
  return result
}

export async function addFlags(client: ImapFlow, range: string, flags: string[], options: StoreOptions = { uid: true }) {
  const result = await client.messageFlagsAdd(range, flags, options)
  if (result === false) throw refused(`STORE +${options.useLabels ? 'X-GM-LABELS' : 'FLAGS'} ${flags.join(' ')}`, range, selected(client))
  return result
}

export async function removeFlags(client: ImapFlow, range: string, flags: string[], options: StoreOptions = { uid: true }) {
  const result = await client.messageFlagsRemove(range, flags, options)
  if (result === false) throw refused(`STORE -${options.useLabels ? 'X-GM-LABELS' : 'FLAGS'} ${flags.join(' ')}`, range, selected(client))
  return result
}

export async function appendMessage(client: ImapFlow, path: string, raw: Buffer, flags: string[], date: Date) {
  const result = await client.append(path, raw, flags, date)
  if (result === false) throw new Error(`IMAP APPEND to ${path} was refused or did not complete`)
  return result
}

export function createSmtpTransport(account: Account, secret: Secret, options: ConnectOptions = {}) {
  const credentials: Credentials = typeof secret === 'string' ? { type: 'password', secret } : secret
  const { smtpHost: host, smtpPort: port, smtpSecurity } = account.servers
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return nodemailer.createTransport({
    host,
    port,
    secure: smtpSecurity === 'ssl',
    requireTLS: smtpSecurity === 'starttls',
    ignoreTLS: smtpSecurity === 'none',
    auth:
      credentials.type === 'oauth'
        ? { type: 'OAuth2' as const, user: account.email, accessToken: credentials.accessToken }
        : { user: account.email, pass: credentials.secret },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    tls: { ...tlsOptions(options), ...(isIP(host) ? {} : { servername: host }) },
  })
}

/**
 * While settings are being checked, a server that says nothing is most often a security mismatch
 * (STARTTLS or none on an SSL/TLS port waits for a greeting that never comes), so say where to look.
 * Sync failures keep the plain wording: there the settings already worked.
 */
const settingsHint = (result: CheckResult & { ok: false }): CheckResult =>
  result.kind === 'timeout' ? { ...result, message: `${result.message} — check the port and security setting` } : result

/** Sign in to IMAP and log out again. */
export async function checkImap(account: Account, secret: Secret, options: ConnectOptions = {}): Promise<CheckResult> {
  const client = createImapClient(account, secret, options)
  client.on('error', () => {}) // surfaced through connect()'s rejection instead
  // imapflow's own timers stop at the greeting: a server that greets and then never answers
  // CAPABILITY, STARTTLS or LOGIN would hold the check (and the wizard's spinner) for the 5-minute
  // socket timeout. The whole sign-in gets twice the connect budget.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Sign-in timed out'), { code: 'ETIMEDOUT' })), 2 * (options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  })
  try {
    await Promise.race([client.connect(), deadline])
    await client.logout().catch(() => {})
    return { ok: true }
  } catch (err) {
    client.close()
    return settingsHint(classify(err, 'imap', account, typeof secret === 'string' ? 'password' : secret.type))
  } finally {
    clearTimeout(timer)
  }
}

/** Sign in to SMTP without sending anything. */
export async function checkSmtp(account: Account, secret: Secret, options: ConnectOptions = {}): Promise<CheckResult> {
  const transport = createSmtpTransport(account, secret, options)
  try {
    await transport.verify()
    return { ok: true }
  } catch (err) {
    return settingsHint(classify(err, 'smtp', account, typeof secret === 'string' ? 'password' : secret.type))
  } finally {
    transport.close()
  }
}

export async function checkAccount(account: Account, secret: Secret, options: ConnectOptions = {}): Promise<ConnectionReport> {
  const [imap, smtp] = await Promise.all([checkImap(account, secret, options), checkSmtp(account, secret, options)])
  return { imap, smtp }
}

type ErrorLike = {
  code?: string
  message?: string
  authenticationFailed?: boolean
  serverResponseCode?: string
  responseText?: string
  responseCode?: number
  cause?: unknown
}

export function classify(err: unknown, protocol: 'imap' | 'smtp', account: Account, auth: Credentials['type'] = 'password'): CheckResult & { ok: false } {
  const e = (err ?? {}) as ErrorLike
  const cause = (e.cause ?? {}) as ErrorLike
  const text = `${e.message ?? ''} ${e.responseText ?? ''} ${cause.message ?? ''}`
  // nodemailer wraps socket failures as a generic ESOCKET; the underlying code is only in the message.
  const codes = new Set([e.code, cause.code, ...(text.match(/\bE[A-Z]{3,}\b/g) ?? [])].filter(Boolean).map(String))
  const has = (...names: string[]) => names.some((name) => codes.has(name))
  const host = protocol === 'imap' ? account.servers.imapHost : account.servers.smtpHost
  const port = protocol === 'imap' ? account.servers.imapPort : account.servers.smtpPort
  const label = protocol === 'imap' ? 'Incoming mail' : 'Outgoing mail'
  const fail = (kind: ConnectionFailure, message: string) => ({ ok: false as const, kind, message })

  if (e.authenticationFailed || e.serverResponseCode === 'AUTHENTICATIONFAILED' || has('EAUTH') || e.responseCode === 535) {
    return fail(
      'auth',
      auth === 'oauth'
        ? `${label}: ${account.email} couldn't sign in — sign in again, or ask an admin to allow mail apps`
        : account.provider === 'gmail'
          ? `${label}: Google didn't accept the app password for ${account.email} — check it, and that 2-Step Verification is on`
          : `${label}: ${account.email} couldn't sign in — check the password`,
    )
  }
  if (has('ENOTFOUND', 'EAI_AGAIN') || /getaddrinfo|DNS/i.test(text)) {
    return fail('host', `${label}: can't find ${host}`)
  }
  if (has('ECONNREFUSED')) return fail('refused', `${label}: ${host} refused connections on port ${port}`)
  if (has('ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT') || /timed? ?out/i.test(text)) {
    return fail('timeout', `${label}: ${host}:${port} didn't respond`)
  }
  if (
    has('ETLS', 'EPROTO') ||
    [...codes].some((c) => /^ERR_SSL|^ERR_TLS|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c)) ||
    /certificate|ssl|tls|wrong version number|handshake|self.signed/i.test(text)
  ) {
    return fail('tls', `${label}: secure connection to ${host}:${port} failed — check the port and security setting`)
  }
  if (has('ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNECTION', 'ESOCKET', 'NoConnection') || /connection (was )?(closed|reset|lost)|socket (hang up|closed)|unexpected close/i.test(text)) {
    return fail('network', `${label}: ${host}:${port} closed the connection — check the port and security setting`)
  }
  return fail('protocol', `${label}: ${serverSaid(host, e)}`)
}

/** Generic library wording that says nothing about what went wrong. */
const GENERIC = /^(command failed|unexpected server response|error|failed)\.?$/i

/**
 * A server's own reply in a sentence: its words, quoted and without IMAP's bracketed response codes,
 * or a plain fallback when all there is is a library's "Command failed".
 */
function serverSaid(host: string, e: ErrorLike): string {
  if (e.serverResponseCode === 'UNAVAILABLE' || e.responseCode === 421 || e.responseCode === 450 || e.responseCode === 451) {
    return `${host} is temporarily unavailable — try again in a few minutes`
  }
  const words = (e.responseText || e.message || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim()
  if (!words || GENERIC.test(words)) return `${host} gave an unexpected answer — try again, or check the server settings`
  return `${host} said “${words.length > 160 ? `${words.slice(0, 159)}…` : words}”`
}
