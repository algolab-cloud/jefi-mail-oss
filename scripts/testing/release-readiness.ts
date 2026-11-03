/** Read-only public release checks. */
const BASE = 'https://jefi.app'
const DOWNLOADS = 'https://downloads.jefi.app'
let failures = 0
async function check(label: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS ${label}`) }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error instanceof Error ? error.message : 'request failed'}`) }
}
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response
}
for (const [path, expected] of [['/terms', 'Terms and licence'], ['/privacy', 'Privacy'], ['/contact', 'contact']] as const) {
  await check(`Public ${path}`, async () => {
    const response = await request(`${BASE}${path}`)
    const html = await response.text()
    if (!response.headers.get('content-type')?.includes('text/html') || !html.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error('Expected page content was not returned')
    }
  })
}
await check('Published release and downloadable artifact', async () => {
  const manifest = await (await request(`${DOWNLOADS}/latest.json`)).json() as Record<string, unknown>
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256) || typeof manifest.url !== 'string') throw new Error('Invalid release manifest')
  const artifact = new URL(manifest.url)
  if (artifact.origin !== DOWNLOADS || artifact.username || artifact.password || !artifact.pathname.endsWith('.dmg')) throw new Error('Unexpected download destination')
  const head = await request(artifact.href, { method: 'HEAD' })
  const bytes = Number(head.headers.get('content-length'))
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Download size unavailable')
  console.log(`  Version ${manifest.version}; ${bytes} bytes available (checksum/signature not verified by this metadata check)`)
})
process.exitCode = failures ? 1 : 0
