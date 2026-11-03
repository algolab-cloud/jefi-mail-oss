/**
 * Cuts a release: bumps the version, commits, tags, and pushes the tag. The tag is what ships it —
 * the Release workflow builds, signs, notarizes and publishes the DMG and latest.json, and every
 * installed copy of Jefi picks the update up from there within a few hours.
 *
 *   bun run release patch        0.1.0 -> 0.1.1   (fixes)
 *   bun run release minor        0.1.0 -> 0.2.0   (features)
 *   bun run release major        0.1.0 -> 1.0.0
 *   bun run release 0.3.0        an exact version
 *   bun run release patch --dry  show what would happen, change nothing
 *
 * Refuses to run with uncommitted changes, off the default branch, behind the remote, or with
 * failing checks: a tag can't be taken back once people have updated to it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const PKG = `${ROOT}/package.json`
const [bump, ...flags] = process.argv.slice(2)
const dry = flags.includes('--dry')
const RELEASE_BRANCH = process.env.JEFI_RELEASE_BRANCH ?? 'main'

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: 'inherit' })
const die = (message: string): never => {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/** The version after `bump`: a keyword moves one part, anything else must be an exact x.y.z. */
export function nextVersion(current: string, bump: string): string | null {
  const [major = 0, minor = 0, patch = 0] = current.split('.').map((n) => Number.parseInt(n, 10) || 0)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  return /^\d+\.\d+\.\d+$/.test(bump) ? bump : null
}

if (import.meta.main) {
  if (!bump) die('Usage: bun run release <patch|minor|major|x.y.z> [--dry]')
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { version: string }
  const version = nextVersion(pkg.version, bump!) ?? die(`"${bump}" isn't patch, minor, major or a version like 0.2.0`)
  const tag = `v${version}`

  // Going backwards would strand everyone already on a higher version: their updater ignores it.
  const older = version.split('.').map(Number).reduce((acc, n, i) => acc || n - Number(pkg.version.split('.')[i] ?? 0), 0) <= 0
  if (older) die(`${version} isn't newer than ${pkg.version}. Installed copies only update to a higher version.`)

  if (git('status', '--porcelain')) die('There are uncommitted changes. Commit or stash them first.')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== RELEASE_BRANCH) die(`Releases are cut from ${RELEASE_BRANCH}; you're on ${branch}. (JEFI_RELEASE_BRANCH overrides this.)`)
  git('fetch', '--tags', 'origin')
  if (git('tag', '--list', tag)) die(`${tag} already exists.`)
  if (git('rev-list', '--count', `HEAD..origin/${branch}`) !== '0') die(`origin/${branch} has commits you don't. Pull first.`)

  console.log(`\nJefi ${pkg.version} -> ${version}${dry ? '   (dry run)' : ''}\n`)
  run('bun', ['run', 'typecheck'])
  run('bun', ['run', 'test'])

  if (dry) {
    console.log(`\nDry run: would set package.json to ${version}, commit, tag ${tag}, and push.`)
    process.exit(0)
  }

  // Only the version line changes, so the file keeps its formatting.
  writeFileSync(PKG, readFileSync(PKG, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${version}$2`))
  git('add', 'package.json')
  git('commit', '-m', `release: ${tag}`)
  git('tag', '-a', tag, '-m', `Jefi ${version}`)
  git('push', 'origin', branch, tag)

  console.log(`\n${tag} is pushed. The Release workflow is building it now:`)
  console.log('  gh run watch            follow the build')
  console.log(`  https://downloads.jefi.app/latest.json   says ${version} when it's live`)
  console.log('Installed copies check every few hours and at launch, and update on their next restart.')
}
