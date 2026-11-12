// ---------------------------------------------------------------------------
// One-click unsubscribe (RFC 8058) makes Jefi POST, without asking, to a URL a sender put in its
// List-Unsubscribe header. Any email can carry that header, so the URL is untrusted: left alone it
// could make the person's Mac hit their router, a dev server on localhost or a NAS on the LAN. Only a
// public https host is POSTed to, and a redirect is never followed (it could point anywhere).
//
// Not covered: DNS rebinding. A public name that resolves to a private address passes this check;
// stopping that needs the resolved address pinned for the connection, which fetch doesn't offer.
// ---------------------------------------------------------------------------

/** True when `url` is safe to POST a one-click unsubscribe to: https, no credentials, a public host. */
export function isSafeUnsubscribeUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  // The URL parser has already lowercased the host and turned every IPv4 spelling (hex, octal, one
  // big number, short forms) into dotted decimal, and IPv6 into its bracketed canonical form.
  const host = parsed.hostname.replace(/\.$/, '')
  if (!host) return false
  if (host.startsWith('[')) {
    const words = ipv6Words(host.slice(1, -1))
    return words !== null && publicIpv6(words)
  }
  const v4 = ipv4Bytes(host)
  if (v4) return publicIpv4(v4)
  return publicName(host)
}

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'localdomain']

function publicName(host: string): boolean {
  // A single label ("intranet", "router") is resolved through the local search domains.
  if (!host.includes('.')) return false
  return !LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/** The four bytes of a dotted-decimal IPv4 address, or null. */
export function ipv4Bytes(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const bytes = parts.map(Number)
  return bytes.every((b) => b <= 255) ? bytes : null
}

function publicIpv4([a, b, c]: number[]): boolean {
  if (a === 0) return false // "this network"; 0.0.0.0 reaches localhost
  if (a === 10) return false // private
  if (a === 100 && b! >= 64 && b! <= 127) return false // CGNAT (100.64.0.0/10)
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local, cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return false // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 168) return false // private
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a! >= 224) return false // multicast, reserved, broadcast
  return true
}

/** The eight 16-bit words of an IPv6 address (with or without an embedded dotted IPv4 tail), or null. */
export function ipv6Words(text: string): number[] | null {
  const address = text.split('%')[0]!.toLowerCase()
  let tail: number[] = []
  let head = address
  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const bytes = ipv4Bytes(dotted[2]!)
    if (!bytes) return null
    tail = [(bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!]
    head = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1)
  }
  const halves = head.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  const groups = halves.map(parse)
  if (!groups.every((g) => g.every((w) => /^[0-9a-f]{1,4}$/.test(w)))) return null
  const words = groups.map((g) => g.map((w) => parseInt(w, 16)))
  const total = 8 - tail.length
  if (words.length === 1) return words[0]!.length === total ? [...words[0]!, ...tail] : null
  const missing = total - words[0]!.length - words[1]!.length
  if (missing < 1) return null
  return [...words[0]!, ...Array<number>(missing).fill(0), ...words[1]!, ...tail]
}

function publicIpv6(w: number[]): boolean {
  const embedded = (hi: number, lo: number) => publicIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
  const zeros = (from: number, to: number) => w.slice(from, to).every((x) => x === 0)
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, which includes :: and ::1)
  if (zeros(0, 5) && w[5] === 0xffff) return embedded(w[6]!, w[7]!)
  if (zeros(0, 6)) return false
  // ::ffff:0:a.b.c.d (IPv4-translated)
  if (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) return embedded(w[6]!, w[7]!)
  // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64): the IPv4 address is what's reached
  if (w[0] === 0x64 && w[1] === 0xff9b) return w[2] === 0 && zeros(3, 6) ? embedded(w[6]!, w[7]!) : false
  // 2002::/16 (6to4) carries an IPv4 address in its next 32 bits
  if (w[0] === 0x2002) return embedded(w[1]!, w[2]!)
  const first = w[0]!
  if ((first & 0xfe00) === 0xfc00) return false // unique local (fc00::/7)
  if ((first & 0xffc0) === 0xfe80) return false // link-local (fe80::/10)
  if ((first & 0xffc0) === 0xfec0) return false // site-local, deprecated (fec0::/10)
  if ((first & 0xff00) === 0xff00) return false // multicast
  if (first === 0x100 && zeros(1, 4)) return false // discard-only (100::/64)
  if (first === 0x2001 && w[1] === 0xdb8) return false // documentation
  if (first === 0x2001 && w[1]! < 0x200) return false // IETF special purpose, Teredo (2001::/23)
  return true
}

export type OneClickResult = 'done' | 'failed' | 'refused'

/**
 * POSTs the RFC 8058 one-click body to `url`, if it's safe to: 'refused' (never sent) for an unsafe
 * URL, 'done' for a 2xx or a redirect (the server took the request; where it points is never
 * followed), 'failed' otherwise.
 */
export async function postOneClickUnsubscribe(url: string, send: typeof fetch = fetch): Promise<OneClickResult> {
  if (!isSafeUnsubscribeUrl(url)) return 'refused'
  try {
    const response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      // A sender's server that never answers mustn't leave Unsubscribe spinning.
      signal: AbortSignal.timeout(15_000),
    })
    const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
    return response.ok || redirected ? 'done' : 'failed'
  } catch {
    return 'failed'
  }
}
