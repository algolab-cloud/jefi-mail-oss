/** Verify Keychain access across different signed builds, using disposable apps and a test secret. */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') throw new Error('This check requires macOS and a Developer ID Application certificate.')
const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
const candidates = [...identities.matchAll(/\b([A-F0-9]{40}) "Developer ID Application: [^"]+"/g)].map((match) => match[1]!)
const identity = process.env.JEFI_SIGN_IDENTITY ?? (candidates.length === 1 ? candidates[0] : undefined)
if (!identity) throw new Error('Set JEFI_SIGN_IDENTITY to choose an installed Developer ID Application certificate.')
const directory = mkdtempSync(join(tmpdir(), 'jefi-keychain-upgrade-'))
const service = `app.jefi.keychain-upgrade-test/${crypto.randomUUID()}`
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
try {
  const executables: string[] = []
  for (const version of [1, 2]) {
    const app = join(directory, `Jefi-${version}.app`)
    const contents = join(app, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    const source = join(directory, `helper-${version}.ts`)
    writeFileSync(source, `
const service = ${JSON.stringify(service)};
const name = 'test-account';
if (process.argv[2] === 'set') await Bun.secrets.set({service, name, value: 'disposable-credential'});
else {
  if (await Bun.secrets.get({service, name}) !== 'disposable-credential') throw new Error('Updated build could not read the credential');
  await Bun.secrets.delete({service, name});
  if (await Bun.secrets.get({service, name}) !== null) throw new Error('Updated build could not remove the credential');
}
console.log('PASS signed build ${version}');
`)
    const executable = join(contents, 'MacOS', 'JefiKeychainTest')
    run('bun', ['build', '--compile', source, '--outfile', executable])
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.jefi.keychain-upgrade-test</string>
<key>CFBundleExecutable</key><string>JefiKeychainTest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>`)
    for (const target of [executable, app]) run('codesign', ['--force', '--timestamp=none', '--options', 'runtime', '--entitlements', join(process.cwd(), 'scripts/release/entitlements.plist'), '--sign', identity, target])
    run('codesign', ['--verify', '--deep', '--strict', app])
    executables.push(executable)
  }
  // An update replaces the installed app at the same path; side-by-side developer binaries are
  // different Keychain clients even when signed by the same team.
  const installed = join(directory, 'Installed.app')
  const installedExecutable = join(installed, 'Contents/MacOS/JefiKeychainTest')
  cpSync(join(directory, 'Jefi-1.app'), installed, { recursive: true })
  process.stdout.write(run(installedExecutable, ['set']))
  rmSync(installed, { recursive: true, force: true })
  cpSync(join(directory, 'Jefi-2.app'), installed, { recursive: true })
  process.stdout.write(run(installedExecutable, ['read-and-delete']))
  console.log('PASS: the next signed build can read and delete the previous build’s test credential.')
} finally {
  // The helper removes its own item on success; clean up the unique test service after failures too.
  try { run('security', ['delete-generic-password', '-s', service, '-a', 'test-account']) } catch {}
  rmSync(directory, { recursive: true, force: true })
}
