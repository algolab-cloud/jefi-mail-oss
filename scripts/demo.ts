/**
 * Opens Jefi on your screen with a realistic sample mailbox: an in-memory IMAP/SMTP server
 * (scripts/testing/fixture.ts), an account already set up, and photos for the sample senders.
 * Nothing touches your real accounts or Keychain entries.
 *
 *   bun run demo
 */
import { startFixture } from './testing/fixture'

const root = process.cwd()
const fixture = await startFixture(`${root}/tmp/demo-home`)
console.log('Demo mailbox running. Close the Jefi window (or press Ctrl+C) to stop.')

const app = Bun.spawn(['bun', 'src/mail.tsx'], {
  cwd: root,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, ...fixture.env, JEFI_SKIP_ONBOARDING: '1', JEFI_DEMO_FACES: `${root}/scripts/testing/faces` },
})

const stop = async () => {
  app.kill()
  await fixture.close()
  process.exit(0)
}
process.on('SIGINT', stop)
await app.exited
await stop()
