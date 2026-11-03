import { describe, expect, test } from 'bun:test'
import { assessEmailLink, normalizeTrustedLinkDomain } from './link-safety'

describe('normalizeTrustedLinkDomain', () => {
  test('normalizes bare and root-only web hosts to an exact ASCII hostname', () => {
    expect(normalizeTrustedLinkDomain(' EXAMPLE.com. ')).toBe('example.com')
    expect(normalizeTrustedLinkDomain('https://BÜCHER.example/')).toBe('xn--bcher-kva.example')
  })

  test('rejects entries with authority or page-specific data', () => {
    expect(normalizeTrustedLinkDomain('*.example.com')).toBeNull()
    expect(normalizeTrustedLinkDomain('https://user@example.com/')).toBeNull()
    expect(normalizeTrustedLinkDomain('https://example.com:8443/')).toBeNull()
    expect(normalizeTrustedLinkDomain('https://example.com/path')).toBeNull()
    expect(normalizeTrustedLinkDomain('https://example.com/?from=email')).toBeNull()
    expect(normalizeTrustedLinkDomain('javascript:alert(1)')).toBeNull()
  })
})

describe('assessEmailLink', () => {
  test('recognizes sender and destination subdomains under the same registrable domain', () => {
    const result = assessEmailLink('https://checkout.acme.co.uk/invoice', 'Alice <billing@mail.acme.co.uk>', [])

    expect(result.kind).toBe('web')
    expect(result.sameDomain).toBe(true)
    expect(result.trusted).toBe(false)
    expect(result.warnings).toEqual([])
  })

  test('detects a deceptive suffix instead of treating it as the sender domain', () => {
    const result = assessEmailLink('https://acme.com.evil.example/login', 'security@acme.com', [])

    expect(result.sameDomain).toBe(false)
    expect(result.warnings).toContain("The destination acme.com.evil.example does not match the sender's domain acme.com.")
  })

  test('uses private suffixes to distinguish tenants on shared hosting', () => {
    const result = assessEmailLink('https://attacker.github.io/reset', 'team@company.github.io', [])

    expect(result.sameDomain).toBe(false)
    expect(result.warnings).toContain("The destination attacker.github.io does not match the sender's domain company.github.io.")
  })

  test('exact trusted hosts suppress only the sender mismatch warning', () => {
    const result = assessEmailLink(
      'http://user:secret@trusted.com:8080/login',
      'sender@different.com',
      ['https://TRUSTED.com/'],
    )

    expect(result.trusted).toBe(true)
    expect(result.sameDomain).toBe(false)
    expect(result.warnings).toEqual([
      'This website does not use an encrypted HTTPS connection.',
      'The address contains embedded sign-in information and may be misleading.',
      'The link uses the unusual network port 8080.',
    ])
  })

  test('trust is exact and does not automatically include subdomains', () => {
    const result = assessEmailLink('https://login.partner.example/', 'sender@acme.example', ['partner.example'])

    expect(result.trusted).toBe(false)
    expect(result.warnings.at(-1)).toBe(
      "The destination login.partner.example does not match the sender's domain acme.example.",
    )
  })

  test('keeps IP and local destinations visibly risky even when explicitly trusted', () => {
    const ip = assessEmailLink('https://2130706433/admin', 'ops@127.0.0.1', ['127.0.0.1'])
    const local = assessEmailLink('https://localhost/settings', 'ops@localhost', ['localhost'])

    expect(ip.host).toBe('127.0.0.1')
    expect(ip.sameDomain).toBe(true)
    expect(ip.trusted).toBe(true)
    expect(ip.warnings).toContain('The destination is an IP address instead of a named website.')
    expect(local.sameDomain).toBe(true)
    expect(local.warnings).toContain('The destination does not use a recognized public website domain.')
  })

  test('surfaces punycode and Unicode destinations for visual review', () => {
    const result = assessEmailLink('https://раypal.com/sign-in', 'notice@paypal.com', [])

    expect(result.host).toContain('xn--')
    expect(result.sameDomain).toBe(false)
    expect(result.warnings).toContain('The destination uses internationalized characters; check the spelling carefully.')
  })

  test('warns that URL shorteners hide the final destination without resolving them', () => {
    const result = assessEmailLink('https://bit.ly/example', 'sender@example.com', [])

    expect(result.canOpen).toBe(true)
    expect(result.warnings).toContain('This is a shortened link, so its final destination is hidden.')
  })

  test('blocks invalid, relative, and dangerous schemes', () => {
    for (const raw of ['not a URL', '/account', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd']) {
      const result = assessEmailLink(raw, 'sender@example.com', [])
      expect(result.kind).toBe('blocked')
      expect(result.canOpen).toBe(false)
      expect(result.url).toBeNull()
    }
  })

  test('allows reviewed mailto links without applying website domain mismatch rules', () => {
    const result = assessEmailLink('mailto:support@different.example?subject=Help', 'sender@acme.example', [])

    expect(result).toMatchObject({
      kind: 'mailto',
      canOpen: true,
      host: 'different.example',
      sameDomain: false,
      trusted: false,
      warnings: [],
    })
  })

  test('flags hidden mail recipients and blocks newline injection', () => {
    const reviewed = assessEmailLink(
      'mailto:help@example.com?BCC=archive@example.com',
      'sender@example.com',
      [],
    )
    const injected = assessEmailLink(
      'mailto:help@example.com?subject=Hello%0ABcc:attacker@example.com',
      'sender@example.com',
      [],
    )

    expect(reviewed.warnings).toEqual(['This link also adds hidden recipients (Bcc).'])
    expect(injected.kind).toBe('blocked')
    expect(injected.canOpen).toBe(false)
    expect(injected.warnings.join(' ')).toContain('line break')
    expect(assessEmailLink('mailto:not-an-address', 'sender@example.com', []).warnings.join(' ')).toContain('invalid or unsupported recipient')
  })

  test('blocks recipient syntax that a mail sender could expand beyond the reviewed addresses', () => {
    for (const raw of [
      'mailto:victim@example.com;attacker@evil.example',
      'mailto:victim@example.com?cc=friend@example.com;attacker@evil.example',
      'mailto:victim@example.com?bcc=archive@example.com;attacker@evil.example',
      'mailto:Team:%20victim@example.com;',
    ]) {
      const result = assessEmailLink(raw, 'sender@example.com', [])
      expect(result.kind).toBe('blocked')
      expect(result.canOpen).toBe(false)
    }
  })

  test('allows line breaks in a mailto body because the draft remains reviewable', () => {
    const result = assessEmailLink(
      'mailto:help@example.com?subject=Hello&body=First%20line%0ASecond%20line',
      'sender@example.com',
      [],
    )

    expect(result.kind).toBe('mailto')
    expect(result.canOpen).toBe(true)
  })
})
