import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { buildLifecycleHelper } from './build-lifecycle'

const commandLineTools = '/Library/Developer/CommandLineTools'
// A selected full Xcode whose license has not been accepted makes xcrun fail before clang runs.
// The separately installed Command Line Tools are sufficient for these helpers and have their own SDK.
const env = () => process.env.DEVELOPER_DIR || !existsSync(`${commandLineTools}/usr/bin/clang`)
  ? process.env
  : { ...process.env, DEVELOPER_DIR: commandLineTools }

function dylib(name: string, source: string, flags: string[], frameworks: string[], out: string) {
  execFileSync(
    'xcrun',
    [
      'clang', '-fobjc-arc', ...flags, '-fmodules', `-mmacosx-version-min=${MINIMUM_MACOS}`, '-dynamiclib',
      ...frameworks.flatMap((framework) => ['-framework', framework]),
      `${import.meta.dir}/${source}`,
      '-install_name', `@rpath/${name}`,
      '-o', `${out}/${name}`,
    ],
    { stdio: 'inherit', env: env() },
  )
}

/** Everything the helpers are built from; the dev bundle hashes these to skip rebuilds. */
export const helperSources = ['notifications.m', 'editor.m', 'mail-snapshot.m', 'lifecycle.m', 'build-helpers.ts', 'build-lifecycle.ts']
  .map((file) => `${import.meta.dir}/${file}`)

/** Compiles every native helper the app loads into `frameworks` (an app's Contents/Frameworks). */
export function buildNativeHelpers(frameworks: string) {
  // UserNotifications invokes delegates on an unspecified queue. This tiny ARC helper retains those
  // native values and marshals them to the app's main queue before its Bun callback runs.
  dylib('libJefiNotifications.dylib', 'notifications.m', [], ['Foundation', 'AppKit', 'UserNotifications', 'Intents', 'Security'], frameworks)
  // GPUI's view is an NSTextInputClient. This helper reads and replaces the exact focused editor
  // range through AppKit, preserving GPUI's native caret, IME, undo and controlled change event.
  dylib('libJefiEditor.dylib', 'editor.m', [], ['Foundation', 'AppKit'], frameworks)
  // Freeze WebKit's current canvas for menus without changing the message's appearance. The ARC
  // helper owns the snapshot completion block and returns PNG bytes on the main queue.
  dylib('libJefiMailSnapshot.dylib', 'mail-snapshot.m', ['-fblocks', '-Wall', '-Wextra', '-Werror'], ['Foundation', 'AppKit', 'WebKit'], frameworks)
  // Closing the window hides it so Jefi keeps running in the menu bar (src/native/app-lifecycle.ts).
  buildLifecycleHelper(`${frameworks}/libJefiLifecycle.dylib`)
}

/** Oldest macOS the app and its helpers support. */
export const MINIMUM_MACOS = '13.0'

export type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue }

const escapeXml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function plistValue(v: PlistValue, indent: string): string {
  if (typeof v === 'boolean') return `<${v}/>`
  if (typeof v === 'string') return `<string>${escapeXml(v)}</string>`
  const inner = `${indent}  `
  if (Array.isArray(v)) return `<array>\n${v.map((item) => `${inner}${plistValue(item, inner)}\n`).join('')}${indent}</array>`
  return `<dict>\n${plistEntries(v, inner)}\n${indent}</dict>`
}

const plistEntries = (entries: Record<string, PlistValue>, indent: string) =>
  Object.entries(entries).map(([k, v]) => `${indent}<key>${escapeXml(k)}</key>\n${indent}${plistValue(v, indent)}`).join('\n')

/** Info.plist XML for a dictionary of strings, booleans, arrays and nested dictionaries. */
export function infoPlist(entries: Record<string, PlistValue>) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plistEntries(entries, '  ')}
</dict>
</plist>
`
}

/** Claims the jefi:// scheme (docs/integrations.md §1). mailto: is deliberately not claimed. */
export const jefiUrlTypes = (name: string): PlistValue => [{ CFBundleURLName: name, CFBundleURLSchemes: ['jefi'] }]
