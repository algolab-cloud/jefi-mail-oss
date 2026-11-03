import { parse as parseDomain } from 'tldts'

export interface LinkAssessment {
  url: string | null
  host: string
  title: string
  detail: string
  warnings: string[]
  canOpen: boolean
  trusted: boolean
  sameDomain: boolean
  kind: 'web' | 'mailto' | 'blocked'
}

const DOMAIN_OPTIONS = { allowPrivateDomains: true, extractHostname: false } as const

const SHORTENER_DOMAINS = new Set([
  'bit.ly',
  'buff.ly',
  'goo.gl',
  'is.gd',
  'ow.ly',
  'rebrand.ly',
  't.co',
  'tinyurl.com',
])

function blocked(detail: string, warning: string): LinkAssessment {
  return {
    url: null,
    host: '',
    title: 'Link blocked',
    detail,
    warnings: [warning],
    canOpen: false,
    trusted: false,
    sameDomain: false,
    kind: 'blocked',
  }
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

function hasValidHostnameSyntax(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  if (hostname.length > 253) return false
  return hostname.split('.').every(
    (label) => label.length > 0
      && label.length <= 63
      && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
  )
}

function parseHost(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  let url: URL
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.port || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (!url.hostname) return null

  const hostname = normalizedHostname(url.hostname)
  return hasValidHostnameSyntax(hostname) ? hostname : null
}

/**
 * Normalize one entry from the user's trusted-domain settings.
 *
 * Bare hosts are preferred, but an http(s) origin with only a root path is
 * accepted for convenient paste handling. Trust is stored as an exact ASCII
 * hostname; paths, credentials, ports, queries, and fragments are rejected.
 */
export function normalizeTrustedLinkDomain(raw: string): string | null {
  return parseHost(raw)
}

function senderHostname(sender: string): string | null {
  const angleAddress = sender.match(/<([^<>]+)>/)?.[1]
  const address = (angleAddress ?? sender).trim().replace(/^mailto:/i, '')
  const at = address.lastIndexOf('@')
  if (at < 1) return null

  const domain = address.slice(at + 1).trim().replace(/^\[/, '').replace(/\]$/, '')
  if (!domain || /[\s,;<>/?#]/.test(domain)) return null
  return parseHost(domain)
}

function sameRegistrableDomain(left: string, right: string): boolean {
  if (left === right) return true

  const leftResult = parseDomain(left, DOMAIN_OPTIONS)
  const rightResult = parseDomain(right, DOMAIN_OPTIONS)
  return leftResult.domain !== null && leftResult.domain === rightResult.domain
}

function authorityContainsUnicode(raw: string): boolean {
  const authority = raw.trim().match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]
  return authority !== undefined && /[^\x00-\x7f]/.test(authority)
}

export type ParsedMailto = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

const DOT_ATOM = /^[a-z\d!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z\d!#$%&'*+/=?^_`{|}~-]+)*$/i

/** Mailto drafts accept only bare addr-spec recipients, never display names, groups, or semicolon lists. */
function bareMailboxes(value: string | null): string[] | null {
  if (value === null || value === '') return []
  const candidates = value.split(',')
  if (candidates.some((candidate) => candidate.trim() === '')) return null
  const addresses: string[] = []
  for (const candidate of candidates) {
    const address = candidate.trim()
    const at = address.indexOf('@')
    if (at < 1 || at !== address.lastIndexOf('@') || !DOT_ATOM.test(address.slice(0, at))) return null
    if (parseHost(address.slice(at + 1)) === null) return null
    addresses.push(address)
  }
  return addresses
}

/** Parse the exact fields used to create a draft after a mailto link is reviewed. */
/** A line break outside the body: a way to slip extra headers (another recipient, say) into a message. */
const hasUnsafeLineBreak = (url: URL) =>
  /%0a|%0d/i.test(url.pathname) || [...url.searchParams].some(([key, value]) => key.toLowerCase() !== 'body' && /[\r\n]/.test(key + value))

export function parseMailtoDraft(raw: string): ParsedMailto | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'mailto:' || url.host || url.hash || hasUnsafeLineBreak(url)) return null

  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const headers = new Map<string, string>()
  for (const [key, value] of url.searchParams) {
    const normalized = key.toLowerCase()
    if (!['cc', 'bcc', 'subject', 'body'].includes(normalized)) continue
    if (headers.has(normalized)) return null
    headers.set(normalized, value)
  }
  const to = bareMailboxes(path)
  const cc = bareMailboxes(headers.get('cc') ?? null)
  const bcc = bareMailboxes(headers.get('bcc') ?? null)
  if (!to?.length || cc === null || bcc === null) return null
  return {
    to,
    cc,
    bcc,
    subject: headers.get('subject') ?? '',
    body: headers.get('body') ?? '',
  }
}

function assessMailto(url: URL): LinkAssessment {
  const draft = parseMailtoDraft(url.href)
  if (!draft) {
    const lineBreak = url.protocol === 'mailto:' && hasUnsafeLineBreak(url)
    return blocked('This email link is malformed.', lineBreak ? "The email link hides a line break in its subject or recipients, which can add headers you didn't write." : 'The email link contains an invalid or unsupported recipient.')
  }

  const warnings: string[] = []
  if (draft.bcc.length) {
    warnings.push('This link also adds hidden recipients (Bcc).')
  }

  const detail = draft.to.length === 1
    ? `This will start an email to ${draft.to[0]}.`
    : `This will start an email to ${draft.to.length} recipients.`

  return {
    url: url.href,
    host: senderHostname(draft.to[0]!) ?? '',
    title: 'Compose email',
    detail,
    warnings,
    canOpen: true,
    trusted: false,
    sameDomain: false,
    kind: 'mailto',
  }
}

/** Assess an absolute email link locally. This function never resolves or fetches the URL. */
export function assessEmailLink(raw: string, sender: string, trustedDomains: readonly string[]): LinkAssessment {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return blocked('This address is not a valid absolute URL.', 'The link could not be parsed.')
  }

  if (url.protocol === 'mailto:') return assessMailto(url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const scheme = url.protocol.slice(0, -1) || 'unknown'
    return blocked(`Jefi does not open ${scheme} links from email.`, `The ${scheme} link type is not allowed.`)
  }

  const host = normalizedHostname(url.hostname)
  if (!host) return blocked('This web link has no destination.', 'The destination host is missing.')

  const senderHost = senderHostname(sender)
  const sameDomain = senderHost !== null && sameRegistrableDomain(host, senderHost)
  const trusted = trustedDomains.some((entry) => normalizeTrustedLinkDomain(entry) === host)
  const hostInfo = parseDomain(host, DOMAIN_OPTIONS)
  const warnings: string[] = []

  if (url.protocol === 'http:') warnings.push('This website does not use an encrypted HTTPS connection.')
  if (url.username || url.password) warnings.push('The address contains embedded sign-in information and may be misleading.')
  if (hostInfo.isIp) warnings.push('The destination is an IP address instead of a named website.')
  else if (hostInfo.domain === null || (hostInfo.isIcann === false && hostInfo.isPrivate === false)) {
    warnings.push('The destination does not use a recognized public website domain.')
  }
  if (host.split('.').some((label) => label.startsWith('xn--')) || authorityContainsUnicode(raw)) {
    warnings.push('The destination uses internationalized characters; check the spelling carefully.')
  }
  if (url.port) warnings.push(`The link uses the unusual network port ${url.port}.`)

  const registrableDomain = hostInfo.domain ?? host
  if (SHORTENER_DOMAINS.has(registrableDomain.replace(/^www\./, ''))) {
    warnings.push('This is a shortened link, so its final destination is hidden.')
  }

  if (!sameDomain && !trusted) {
    warnings.push(
      senderHost
        ? `The destination ${host} does not match the sender's domain ${senderHost}.`
        : 'The sender domain could not be verified against this destination.',
    )
  }

  const detail = sameDomain
    ? `This destination matches the domain in the From address (${senderHost}). This does not verify the sender.`
    : trusted
      ? `You saved ${host} as a trusted domain. Review any warnings before opening.`
      : senderHost
        ? `This destination domain differs from the From address domain (${senderHost}). A different domain is not proof that the link is unsafe.`
        : 'Review the destination before opening it.'

  return {
    url: url.href,
    host,
    title: `Open link to ${host}`,
    detail,
    warnings,
    canOpen: true,
    trusted,
    sameDomain,
    kind: 'web',
  }
}
