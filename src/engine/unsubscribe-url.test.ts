import { expect, test } from 'bun:test'
import { parseUnsubscribe } from './scrub'
import { ipv6Words, isSafeUnsubscribeUrl, postOneClickUnsubscribe } from './unsubscribe-url'

test('a public https host is allowed', () => {
  for (const url of [
    'https://deals.example.com/u/42',
    'https://list.example.org:8443/unsubscribe?id=1&t=abc',
    'https://EXAMPLE.com./u',
    'https://8.8.8.8/u',
    'https://[2606:4700:4700::1111]/u',
    'https://[::ffff:8.8.8.8]/u',
    'https://[2002:808:808::1]/u',
    'https://[64:ff9b::808:808]/u',
    'https://xn--bcher-kva.example/u',
  ])
    expect([url, isSafeUnsubscribeUrl(url)]).toEqual([url, true])
})

test('anything but https is refused', () => {
  for (const url of ['http://deals.example.com/u', 'ftp://deals.example.com/u', 'mailto:leave@deals.example', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', ''])
    expect([url, isSafeUnsubscribeUrl(url)]).toEqual([url, false])
})

test('credentials in the URL are refused', () => {
  expect(isSafeUnsubscribeUrl('https://user:pw@deals.example.com/u')).toBe(false)
  expect(isSafeUnsubscribeUrl('https://user@deals.example.com/u')).toBe(false)
  expect(isSafeUnsubscribeUrl('https://:pw@deals.example.com/u')).toBe(false)
})

test('local names are refused', () => {
  for (const url of [
    'https://localhost/u',
    'https://LOCALHOST./u',
    'https://app.localhost/u',
    'https://printer.local/u',
    'https://nas.home.arpa/u',
    'https://metadata.google.internal/u',
    'https://intranet/u',
    'https://router./u',
  ])
    expect([url, isSafeUnsubscribeUrl(url)]).toEqual([url, false])
})

test('private, loopback, link-local and CGNAT IPv4 literals are refused, however they are spelled', () => {
  for (const url of [
    'https://127.0.0.1/u',
    'https://127.8.9.10/u',
    'https://0.0.0.0/u',
    'https://10.0.0.1/u',
    'https://172.16.0.1/u',
    'https://172.31.255.255/u',
    'https://192.168.1.1/u',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/u',
    'https://100.127.255.255/u',
    'https://224.0.0.1/u',
    'https://255.255.255.255/u',
    'https://198.18.0.1/u',
    // Other spellings of 127.0.0.1 the URL parser normalises.
    'https://2130706433/u',
    'https://0x7f000001/u',
    'https://0177.0.0.1/u',
    'https://127.1/u',
    'https://0x7f.0.0.1/u',
    'https://127.0.0.1./u',
  ])
    expect([url, isSafeUnsubscribeUrl(url)]).toEqual([url, false])
  // Just outside those ranges is public.
  for (const url of ['https://172.32.0.1/u', 'https://100.128.0.1/u', 'https://11.0.0.1/u', 'https://192.169.0.1/u', 'https://169.255.0.1/u'])
    expect([url, isSafeUnsubscribeUrl(url)]).toEqual([url, true])
})

test('loopback, unique-local, link-local and IPv4-mapped private IPv6 literals are refused', () => {
  for (const url of [
    'https://[::1]/u',
    'https://[::]/u',
    'https://[0:0:0:0:0:0:0:1]/u',
    'https://[fc00::1]/u',
    'https://[fd12:3456:789a::1]/u',
    'https://[fe80::1]/u',
    'https://[febf::1]/u',
    'https://[fec0::1]/u',
    'https://[ff02::1]/u',
    'https://[::ffff:127.0.0.1]/u',
    'https://[::ffff:7f00:1]/u',
    'https://[::ffff:10.0.0.1]/u',
    'https://[::ffff:169.254.169.254]/u',
    'https://[::ffff:192.168.0.1]/u',
    'https://[::127.0.0.1]/u',
    'https://[::ffff:0:127.0.0.1]/u',
    'https://[64:ff9b::7f00:1]/u',
    'https://[64:ff9b::a00:1]/u',
    'https://[2002:7f00:1::1]/u',
    'https://[2002:c0a8:101::1]/u',
    'https://[2001:db8::1]/u',
    'https://[2001::1]/u',
    'https://[100::1]/u',
  ])
    expect([url, isSafeUnsubscribeUrl(url)]).toEqual([url, false])
})

test('IPv6 text expands to its eight words', () => {
  expect(ipv6Words('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  expect(ipv6Words('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(ipv6Words('fe80::1%en0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
  expect(ipv6Words('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304])
  expect(ipv6Words('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(ipv6Words('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x102, 0x304])
  expect(ipv6Words('1::2::3')).toBeNull()
  expect(ipv6Words('1:2:3:4:5:6:7:8:9')).toBeNull()
  expect(ipv6Words('1:2:3:4::5:6:7:8')).toBeNull()
  expect(ipv6Words('12345::')).toBeNull()
  expect(ipv6Words('::ffff:1.2.3.256')).toBeNull()
})

test('a header pointing at a private host offers no one-click, only the link to open', () => {
  expect(parseUnsubscribe('<https://127.0.0.1/u>', true)).toEqual({ oneClick: null, link: 'https://127.0.0.1/u', mailto: null })
  expect(parseUnsubscribe('<https://deals.example/u>', true).oneClick).toBe('https://deals.example/u')
})

const recording = (respond: () => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const send = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return respond()
  }) as unknown as typeof fetch
  return { calls, send }
}

test('one-click POSTs the RFC 8058 body to a safe URL and never follows a redirect', async () => {
  const ok = recording(() => new Response('', { status: 200 }))
  expect(await postOneClickUnsubscribe('https://deals.example/u/42', ok.send)).toBe('done')
  expect(ok.calls).toHaveLength(1)
  expect(ok.calls[0]!.url).toBe('https://deals.example/u/42')
  expect(ok.calls[0]!.init).toMatchObject({ method: 'POST', body: 'List-Unsubscribe=One-Click', redirect: 'manual' })

  // A redirect means the server took the request; where it points is not fetched.
  for (const status of [301, 302, 303, 307, 308]) {
    const moved = recording(() => new Response(null, { status, headers: { location: 'http://127.0.0.1/admin' } }))
    expect(await postOneClickUnsubscribe('https://deals.example/u/42', moved.send)).toBe('done')
    expect(moved.calls).toHaveLength(1)
  }
})

test('one-click to an unsafe URL is never sent', async () => {
  const never = recording(() => new Response('', { status: 200 }))
  for (const url of ['https://127.0.0.1/u', 'https://[::1]/u', 'https://localhost/u', 'http://deals.example/u', 'https://a:b@deals.example/u'])
    expect(await postOneClickUnsubscribe(url, never.send)).toBe('refused')
  expect(never.calls).toEqual([])
})

test('one-click fails on an error status or a network error', async () => {
  expect(await postOneClickUnsubscribe('https://deals.example/u', recording(() => new Response('', { status: 500 })).send)).toBe('failed')
  expect(await postOneClickUnsubscribe('https://deals.example/u', recording(() => new Response('', { status: 404 })).send)).toBe('failed')
  expect(
    await postOneClickUnsubscribe(
      'https://deals.example/u',
      recording(() => {
        throw new TypeError('fetch failed')
      }).send,
    ),
  ).toBe('failed')
})

test('a real fetch with redirect manual hands back the redirect instead of following it', async () => {
  let followed = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/next') followed++
      return new Response(null, { status: 302, headers: { location: '/next' } })
    },
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/u`, { method: 'POST', redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(followed).toBe(0)
  } finally {
    server.stop(true)
  }
})
