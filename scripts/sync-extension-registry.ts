/**
 * Copies the Jefi extension (integrations/raycast) into a checkout of the public registry repo, laid
 * out like raycast/extensions, so publishing an update is one command plus a commit there:
 *
 *   bun scripts/sync-extension-registry.ts /path/to/jefi-extensions
 *
 * Replaces <registry>/extensions/jefi wholesale, so files deleted here disappear there too. Only files
 * git would track are copied (tracked plus untracked-but-not-ignored), which keeps node_modules, dist
 * and raycast-env.d.ts out without a second ignore list.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const registry = process.argv[2]
if (!registry) {
  console.error('usage: bun scripts/sync-extension-registry.ts <registry checkout>')
  process.exit(1)
}
const root = resolve(registry)
if (!existsSync(join(root, '.git'))) {
  console.error(`${root} is not a git checkout`)
  process.exit(1)
}

const source = resolve(import.meta.dir, '../integrations/raycast')
const target = join(root, 'extensions/jefi')
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(join(source, f)))

rmSync(target, { recursive: true, force: true })
for (const f of files) {
  mkdirSync(dirname(join(target, f)), { recursive: true })
  copyFileSync(join(source, f), join(target, f))
}
console.log(`copied ${files.length} files to ${target}`)
console.log(`next: cd ${root} && git add -A && git commit -m "Update Jefi extension" && git push`)
