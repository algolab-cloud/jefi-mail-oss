import { expect, test } from 'bun:test'
import { WebRiskError, type WebRiskVerdict } from '../../src/web-risk'
import { formatWebRiskSmokeError, runWebRiskSmoke, WEB_RISK_SMOKE_URLS } from './web-risk-smoke'

test('live smoke checks a benign URL and the official malware test without visiting either target', async () => {
  const calls: Array<{ url: string; key: string; options: unknown }> = []
  const verdicts: WebRiskVerdict[] = [
    { kind: 'no-match', checkedAt: 1, source: 'google' },
    { kind: 'threat', threatTypes: ['MALWARE'], expiresAt: 2, source: 'google' },
  ]
  const lines = await runWebRiskSmoke('  private-key  ', async (url, key, options) => {
    calls.push({ url, key, options })
    return verdicts.shift()!
  })

  expect(calls).toEqual([
    { url: WEB_RISK_SMOKE_URLS.benign, key: 'private-key', options: { bypassCache: true, timeoutMs: 15_000 } },
    { url: WEB_RISK_SMOKE_URLS.malware, key: 'private-key', options: { bypassCache: true, timeoutMs: 15_000 } },
  ])
  expect(lines.join('\n')).not.toContain('private-key')
  expect(lines.at(-1)).toContain('can perform live')
})

test('a no-match for the official test URL is a failed verification, not a clean verdict', async () => {
  await expect(
    runWebRiskSmoke('key', async () => ({ kind: 'no-match', checkedAt: 1, source: 'google' })),
  ).rejects.toThrow('did not return a MALWARE match')
})

test('diagnostics redact a key even if a failed transport echoed it', () => {
  expect(formatWebRiskSmokeError(new Error('request private-key failed'), 'private-key')).toBe(
    'request [redacted] failed Check the current Web Risk Lookup API status and try again.',
  )
  expect(formatWebRiskSmokeError(new WebRiskError('auth', 'Google rejected the key.'), 'private-key')).toContain(
    'webrisk.googleapis.com is enabled',
  )
})
