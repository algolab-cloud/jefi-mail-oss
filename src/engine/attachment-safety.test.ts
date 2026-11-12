import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileExtension, isRiskyAttachment, openAttachmentFile, openCommand, quarantine, quarantineCommand, quarantineValue } from './attachment-safety'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

test('files that run, install or point somewhere are risky; documents are not', () => {
  for (const name of ['Installer.pkg', 'Update.dmg', 'run.command', 'Shell.terminal', 'tool.app', 'site.inetloc', 'link.webloc', 'file.fileloc', 'script.scpt', 'go.sh', 'setup.exe', 'archive.zip', 'Xcode.xip', 'profile.mobileconfig', 'Do it.shortcut', 'flow.workflow']) {
    expect(isRiskyAttachment(name)).toBe(true)
  }
  for (const name of ['report.pdf', 'photo.jpeg', 'budget.xlsx', 'notes.txt', 'invite.ics', 'letter.docx', 'README', 'movie.mov']) {
    expect(isRiskyAttachment(name)).toBe(false)
  }
})

test('case, trailing dots and spaces, and decoy extensions do not hide the real one', () => {
  expect(isRiskyAttachment('INVOICE.PKG')).toBe(true)
  expect(isRiskyAttachment('invoice.pdf.command')).toBe(true)
  expect(isRiskyAttachment('invoice.command.')).toBe(true)
  expect(isRiskyAttachment('invoice.command .')).toBe(true)
  // Right-to-left override: the name displays as "invoicednammoc.pdf", but the extension is still command.
  expect(isRiskyAttachment('invoice\u202Efdp.command')).toBe(true)
  expect(isRiskyAttachment('invoice.command.pdf')).toBe(false)
  expect(fileExtension('.hidden')).toBe('')
  expect(fileExtension('archive.tar.gz')).toBe('gz')
})

test('documents open with the system open; risky files are only shown in Finder', () => {
  expect(openCommand('/Users/x/.config/jefi/attachments/a/1/0/report.pdf')).toEqual({ argv: ['/usr/bin/open', '/Users/x/.config/jefi/attachments/a/1/0/report.pdf'], revealed: false })
  expect(openCommand('/Users/x/.config/jefi/attachments/a/1/0/Installer.pkg')).toEqual({ argv: ['/usr/bin/open', '-R', '/Users/x/.config/jefi/attachments/a/1/0/Installer.pkg'], revealed: true })
  // Never a relative path, which `open` could read as an option.
  expect(openCommand('-a Terminal.pdf').argv.at(-1)!.startsWith('/')).toBe(true)
})

test('the quarantine command marks the file as downloaded by Jefi, now', () => {
  const now = Date.UTC(2026, 10, 12, 16, 0, 0)
  expect(quarantineValue(now)).toBe(`0081;${(now / 1000).toString(16)};Jefi;`)
  expect(quarantineValue(now + 999)).toBe(quarantineValue(now))
  expect(quarantineCommand('/tmp/a b/report.pdf', now)).toEqual(['/usr/bin/xattr', '-w', 'com.apple.quarantine', `0081;${(now / 1000).toString(16)};Jefi;`, '/tmp/a b/report.pdf'])
})

test('quarantining runs xattr on macOS only, and a failure is logged rather than thrown', async () => {
  const runs: string[][] = []
  const logs: string[] = []
  const run = async (argv: string[]) => (runs.push(argv), 0)
  expect(await quarantine('/tmp/x.pdf', { platform: 'linux', run })).toBe(false)
  expect(runs).toEqual([])

  expect(await quarantine('/tmp/x.pdf', { platform: 'darwin', run, now: () => 16_000 })).toBe(true)
  expect(runs).toEqual([quarantineCommand('/tmp/x.pdf', 16_000)])

  expect(await quarantine('/tmp/x.pdf', { platform: 'darwin', run: async () => 1, log: (m) => logs.push(m) })).toBe(false)
  expect(await quarantine('/tmp/x.pdf', { platform: 'darwin', run: async () => { throw new Error('no xattr') }, log: (m) => logs.push(m) })).toBe(false)
  expect(logs).toHaveLength(2)
})

test('opening quarantines a file that has no mark yet, then opens or reveals it', async () => {
  const runs: string[][] = []
  // xattr -p fails: no mark yet.
  const run = async (argv: string[]) => (runs.push(argv), argv[1] === '-p' ? 1 : 0)
  expect(await openAttachmentFile('/tmp/a/Setup.pkg', { run, platform: 'darwin' })).toEqual({ revealed: true, code: 0 })
  expect(runs.map((argv) => argv.slice(0, 2))).toEqual([['/usr/bin/xattr', '-p'], ['/usr/bin/xattr', '-w'], ['/usr/bin/open', '-R']])

  // Already marked: the mark (and any approval in it) is left alone.
  runs.length = 0
  expect(await openAttachmentFile('/tmp/a/report.pdf', { run: async (argv) => (runs.push(argv), 0), platform: 'darwin' })).toEqual({ revealed: false, code: 0 })
  expect(runs).toEqual([['/usr/bin/xattr', '-p', 'com.apple.quarantine', '/tmp/a/report.pdf'], ['/usr/bin/open', '/tmp/a/report.pdf']])
})

test.if(process.platform === 'darwin')('on this Mac, the mark really lands on the file', async () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-quarantine-`)
  dirs.push(dir)
  const file = `${dir}/report.pdf`
  writeFileSync(file, 'x')
  expect(await quarantine(file, { now: () => 0x6000_0000_000 })).toBe(true)
  const value = Bun.spawnSync(['/usr/bin/xattr', '-p', 'com.apple.quarantine', file]).stdout.toString().trim()
  expect(value.startsWith('0081;')).toBe(true)
  expect(value.endsWith(';Jefi;')).toBe(true)
})
