import { basename, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Handing a downloaded attachment to macOS. Two guards, both because anyone can send anyone mail:
//
// - Every attachment is marked as downloaded (the com.apple.quarantine attribute browsers and Mail
//   set), so Gatekeeper checks whatever it launches and macOS warns before running it.
// - A file that runs or installs something when opened (apps, installers, scripts, Terminal and
//   location files, archives that can carry them) is never launched with one click: Jefi shows it
//   in Finder instead, where opening it is the person's own deliberate step.
// ---------------------------------------------------------------------------

/**
 * Extensions that run code, install something, change settings or point somewhere else when opened
 * (lowercase, without the dot).
 */
export const RISKY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Apps, installers and disk images.
  'app', 'pkg', 'mpkg', 'dmg', 'iso', 'img', 'sparseimage', 'sparsebundle', 'mobileconfig', 'ipa',
  // Bundles macOS loads into other programs.
  'prefpane', 'kext', 'dext', 'plugin', 'bundle', 'saver', 'qlgenerator', 'mdimporter', 'osax', 'wdgt', 'xpc', 'appex', 'systemextension', 'dylib', 'so',
  // Scripts, Terminal settings, Automator and Shortcuts.
  'command', 'tool', 'terminal', 'sh', 'bash', 'zsh', 'csh', 'tcsh', 'ksh', 'fish', 'py', 'pyc', 'pyw', 'rb', 'pl', 'jxa',
  'scpt', 'scptd', 'applescript', 'workflow', 'action', 'shortcut', 'jar',
  // Shortcut and location files: they open whatever they point at.
  'inetloc', 'webloc', 'fileloc', 'afploc', 'ftploc', 'mailloc', 'newsloc', 'url', 'desktop', 'lnk',
  // Windows programs and scripts (harmless here unless something runs them, so don't).
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'vbs', 'vbe', 'ps1', 'hta', 'wsf', 'reg', 'cpl',
  // Archives Archive Utility expands with one click, and which can hold any of the above.
  'zip', 'xip', 'tar', 'tgz', 'gz', 'bz2', 'tbz', 'xz', 'txz', '7z', 'rar', 'cpio', 'cab',
])

/** The last extension of a file name, lowercased; trailing dots and spaces don't hide it. */
export function fileExtension(name: string): string {
  const leaf = name.replace(/[.\s]+$/, '')
  const dot = leaf.lastIndexOf('.')
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : ''
}

/** Opening this file could run or install something, or send the person somewhere else. */
export const isRiskyAttachment = (name: string) => RISKY_EXTENSIONS.has(fileExtension(name))

/**
 * How to hand `path` to macOS: open it in its default app, or for a risky file, select it in Finder
 * (`open -R`) instead. Always the system `open`, never whichever one is first on PATH.
 */
export function openCommand(path: string): { argv: string[]; revealed: boolean } {
  const absolute = resolve(path)
  const revealed = isRiskyAttachment(basename(absolute))
  return { argv: revealed ? ['/usr/bin/open', '-R', absolute] : ['/usr/bin/open', absolute], revealed }
}

export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'

/**
 * The quarantine attribute's value: flags (0x0081: downloaded, and checked by Gatekeeper), the time
 * in hex seconds, and the app that downloaded it.
 */
export const quarantineValue = (now: number) => `0081;${Math.floor(now / 1000).toString(16)};Jefi;`

/** `xattr` writing the quarantine attribute onto `path`. */
export const quarantineCommand = (path: string, now: number) => ['/usr/bin/xattr', '-w', QUARANTINE_ATTRIBUTE, quarantineValue(now), resolve(path)]

type Run = (argv: string[]) => Promise<number>
const run: Run = async (argv) => Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).exited

export type QuarantineOptions = { platform?: NodeJS.Platform; now?: () => number; run?: Run; log?: (message: string) => void }

/**
 * Marks a downloaded file as quarantined. macOS only; never throws, and a failure is logged rather
 * than failing the download (the file is still worth having, and the open guard still applies).
 * With `onlyIfMissing`, leaves an attribute that's already there (and any approval it records) alone.
 */
export async function quarantine(path: string, options: QuarantineOptions & { onlyIfMissing?: boolean } = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'darwin') return false
  const exec = options.run ?? run
  const log = options.log ?? ((message: string) => console.warn(message))
  try {
    if (options.onlyIfMissing && (await exec(['/usr/bin/xattr', '-p', QUARANTINE_ATTRIBUTE, resolve(path)])) === 0) return true
    const code = await exec(quarantineCommand(path, (options.now ?? Date.now)()))
    if (code !== 0) log(`jefi: couldn't quarantine ${path} (xattr exited ${code})`)
    return code === 0
  } catch (err) {
    log(`jefi: couldn't quarantine ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * Opens a downloaded attachment the safe way: quarantined first (a file cached by an older Jefi may
 * not be), then opened, or revealed in Finder when it's risky. Resolves with `open`'s exit code.
 */
export async function openAttachmentFile(path: string, options: { run?: Run; platform?: NodeJS.Platform } = {}): Promise<{ revealed: boolean; code: number }> {
  await quarantine(path, { ...options, onlyIfMissing: true })
  const { argv, revealed } = openCommand(path)
  return { revealed, code: await (options.run ?? run)(argv) }
}
