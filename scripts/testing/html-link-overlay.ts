/**
 * Visible native regression check for Full HTML overlays.
 *
 * Run against source after `bun run bundle` has built the native artifacts:
 * NAPI_RS_NATIVE_LIBRARY_PATH="$PWD/build/native/gpuix-native.darwin-arm64.node" \
 *   bun scripts/testing/html-link-overlay.ts
 */
import assert from 'node:assert/strict'
import { launch } from '@gpuix/react/automation'
import { SECRET_SERVICE } from '../../src/engine/secrets'
import { rawMessage, USER } from '../../src/engine/testing/imap-server'
import { startFixture } from './fixture'

const root = process.cwd()
const base = `${root}/tmp/html-link-overlay-regression`
const proofPath = process.env.JEFI_HTML_PROOF_PATH || `${base}.png`
const executable = process.env.JEFI_HTML_EXECUTABLE
const fixture = await startFixture(`${base}-home`)
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

if (executable && process.platform === 'darwin') {
  // The packaged app ignores JEFI_TEST_SECRETS_FILE (src/keychain.ts), so it needs a real Keychain
  // item: a synthetic credential with an ACL scoped to the exact disposable/final executable under
  // test, removed again in the finally block below.
  Bun.spawnSync(['/usr/bin/security', 'delete-generic-password', '-s', SECRET_SERVICE, '-a', fixture.account.id])
  const keychain = Bun.spawnSync([
    '/usr/bin/security', 'add-generic-password', '-a', fixture.account.id, '-s', SECRET_SERVICE,
    '-w', USER.pass, '-T', executable,
  ])
  assert.equal(keychain.exitCode, 0, `could not authorize the packaged fixture credential: ${keychain.stderr.toString()}`)
}

fixture.imap.append('INBOX', { raw: rawMessage({
  n: 9941,
  fromName: 'HTML QA',
  fromEmail: 'sender@fixture.example',
  subject: 'Full HTML overlay regression',
  date: new Date(Date.now() + 60_000),
  text: 'Synthetic fallback text.',
  html: `<!doctype html><html><head><style>
    body{background:#fff;color:#172033} h1{font-size:26px} p{font-size:17px;line-height:1.5}
    .proof{padding:28px;border:3px solid #3e63dd;border-radius:12px;background:#eef3ff}
    .edge{position:fixed;right:24px;top:210px;display:block;padding:16px 22px;background:#5b3df5;color:white;border-radius:10px;font-size:18px;font-weight:700}
  </style></head><body><div class="proof"><h1>Native HTML remains visible</h1>
  <p>The public WebKit snapshot must preserve these styled pixels behind every GPUI overlay.</p></div>
  <a class="edge" href="https://edge.example.test/account?token=synthetic">Review destination</a></body></html>`,
}) })

const app = await launch({
  command: executable || 'bun',
  args: executable ? [] : ['src/mail.tsx'],
  cwd: root,
  env: { JEFI_SKIP_ONBOARDING: '1', ...fixture.env },
})

let failure: unknown
try {
  let rows = await app.getByText('Full HTML overlay regression').all()
  for (let attempt = 0; !rows.length && attempt < 100; attempt++) {
    await wait(200)
    rows = await app.getByText('Full HTML overlay regression').all()
  }
  const row = rows.find((candidate) => candidate.bounds && candidate.bounds.x < 700) ?? rows[0]
  assert(row?.bounds, 'synthetic HTML message row must be visible')
  await app.mouse.click({ x: row.bounds.x + 100, y: row.bounds.y + row.bounds.height / 2 })
  await app.getByTestId('html-full').waitFor({ timeoutMs: 5_000 })
  await wait(1_000)

  // A GPUI menu over the page needs a frozen canvas while it is above the native child view. (Link
  // reviews reach the same capture path from a real click inside the page, which automation can't make.)
  await app.getByTestId('action-more').click()
  await app.getByTestId('action-forward').waitFor({ timeoutMs: 3_000 })
  await app.getByTestId('html-overlay-snapshot').waitFor({ timeoutMs: 3_000 })
  const snapshot = await app.getByTestId('html-overlay-snapshot').bounds()
  assert(snapshot.width > 100 && snapshot.height > 100, 'rich canvas snapshot must cover the Full HTML view')
  await app.screenshot({ path: proofPath })
  await app.getByTestId('action-forward').click()
  await wait(250)
  assert.equal(await app.getByTestId('html-overlay-snapshot').count(), 0, 'closing a generic menu must restore the live WKWebView')

  console.log(JSON.stringify({ proofPath, snapshot }))
} catch (error) {
  failure = error
} finally {
  await app.close()
  await fixture.close()
  if (executable && process.platform === 'darwin') Bun.spawnSync(['/usr/bin/security', 'delete-generic-password', '-s', SECRET_SERVICE, '-a', fixture.account.id])
}

if (failure) {
  console.error(failure)
  process.exit(1)
}
process.exit(0)
