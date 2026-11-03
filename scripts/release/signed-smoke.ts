/**
 * Runs the signed dist/Jefi.app before it goes to Apple (release.yml, between signing and notarizing):
 *
 *   bun scripts/release/signed-smoke.ts [path/to/Jefi.app]
 *
 * Proves the hardened-runtime executable starts headless (`Jefi cli version --json` reports this
 * version) and that every helper in Contents/Frameworks loads under the signature
 * (`Jefi cli selftest --json`). Either failing exits non-zero and stops the release.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SelftestResult } from '../../src/headless/selftest'

const ROOT = process.cwd()
const APP = process.argv[2] ?? `${ROOT}/dist/Jefi.app`
const EXEC = `${APP}/Contents/MacOS/Jefi`

// A throwaway HOME: neither command reads mail data, and a release must never touch real settings.
const home = mkdtempSync(`${tmpdir()}/jefi-smoke-`)
const failures: string[] = []

function cli(...args: string[]): { code: number; json: unknown } {
  const result = spawnSync(EXEC, ['cli', ...args, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 60_000 })
  if (result.stderr) process.stderr.write(result.stderr)
  let json: unknown = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    failures.push(`\`Jefi cli ${args.join(' ')}\` printed no JSON (exit ${result.status}, signal ${result.signal}):\n${result.stdout}`)
  }
  return { code: result.status ?? 1, json }
}

// codesign --display writes its report to stderr.
const signature = spawnSync('codesign', ['--display', '--verbose=2', EXEC], { encoding: 'utf8' })
if (signature.status !== 0) failures.push(`codesign couldn't read ${EXEC}:\n${signature.stderr}`)
else if (!/flags=\S*\(.*runtime.*\)/.test(signature.stderr)) failures.push(`${EXEC} is not signed with the hardened runtime.`)

try {
  const expected = (JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as { version: string }).version
  const version = cli('version')
  const got = (version.json as { version?: string } | null)?.version
  console.log(`version: ${got ?? '(none)'} (exit ${version.code})`)
  if (version.code !== 0 || got !== expected) failures.push(`\`Jefi cli version\` reported ${got ?? 'nothing'} with exit ${version.code}; expected ${expected}.`)

  const test = cli('selftest')
  const result = test.json as SelftestResult | null
  for (const h of result?.helpers ?? []) console.log(`${h.ok ? 'ok  ' : 'FAIL'}  ${h.file}${h.error ? `  ${h.error}` : ''}`)
  if (test.code !== 0 || !result?.ok) failures.push(`\`Jefi cli selftest\` failed (exit ${test.code}).`)
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\nsigned app smoke test failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`)
  process.exit(1)
}
console.log('\nsigned app smoke test passed')
