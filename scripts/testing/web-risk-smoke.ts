#!/usr/bin/env bun
/**
 * Opt-in live check for a person's Google Web Risk API key.
 *
 * The key is read from a hidden prompt or JEFI_WEB_RISK_API_KEY. It is never
 * printed, persisted, or placed in a command-line argument. This script calls
 * only the Web Risk Lookup API; it never requests either checked URL.
 */
import { checkWebRiskUrl, WebRiskError, type WebRiskLookupOptions, type WebRiskVerdict } from '../../src/web-risk'
import { readHiddenSecret } from './hidden-secret'

export const WEB_RISK_SMOKE_URLS = {
  benign: 'https://example.com/',
  malware: 'http://testsafebrowsing.appspot.com/s/malware.html',
} as const

type Lookup = (url: string, apiKey: string, options?: WebRiskLookupOptions) => Promise<WebRiskVerdict>

export async function runWebRiskSmoke(apiKey: string, lookup: Lookup = checkWebRiskUrl): Promise<string[]> {
  const key = apiKey.trim()
  if (!key) throw new WebRiskError('missing-key', 'No Google Web Risk API key was provided.')
  const options = { bypassCache: true, timeoutMs: 15_000 } as const
  const benign = await lookup(WEB_RISK_SMOKE_URLS.benign, key, options)
  if (benign.kind !== 'no-match') throw new Error('The fixed benign URL unexpectedly matched a threat list.')

  const malware = await lookup(WEB_RISK_SMOKE_URLS.malware, key, options)
  if (malware.kind !== 'threat' || !malware.threatTypes.includes('MALWARE')) {
    throw new Error("Google's documented malware test URL did not return a MALWARE match.")
  }

  return [
    'PASS  Fixed benign URL returned no match.',
    `PASS  Official Google test URL returned ${malware.threatTypes.join(', ')}.`,
    'PASS  The API key can perform live Web Risk Lookup requests.',
  ]
}

export function formatWebRiskSmokeError(error: unknown, apiKey: string): string {
  const key = apiKey.trim()
  const raw = error instanceof Error ? error.message : 'Unknown failure.'
  const message = key ? raw.split(key).join('[redacted]') : raw
  if (!(error instanceof WebRiskError)) return `${message} Check the current Web Risk Lookup API status and try again.`
  switch (error.code) {
    case 'auth':
      return `${message} Confirm billing is enabled, webrisk.googleapis.com is enabled, and the key is permitted to use that API.`
    case 'quota':
      return `${message} Check the Google Cloud project's Web Risk quota and billing.`
    case 'timeout':
    case 'unavailable':
      return `${message} Check network access to webrisk.googleapis.com and try again.`
    case 'invalid-response':
      return `${message} The live response did not match the documented Lookup API schema.`
    default:
      return message
  }
}

if (import.meta.main) {
  console.log('Google Web Risk live smoke')
  console.log('This makes two Lookup API requests and never visits either checked URL.\n')
  let key = ''
  try {
    key = await readHiddenSecret('JEFI_WEB_RISK_API_KEY', 'Google Web Risk API key (hidden): ')
    for (const line of await runWebRiskSmoke(key)) console.log(line)
  } catch (error) {
    console.error(`FAIL  ${formatWebRiskSmokeError(error, key)}`)
    process.exitCode = 1
  }
}
