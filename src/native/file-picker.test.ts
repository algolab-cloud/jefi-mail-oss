import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeAttachmentSaveName, saveAttachmentInDirectory } from './file-picker'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('saving attachment copies', () => {
  test('sanitizes both path separators, control characters, and long UTF-8 names', () => {
    expect(safeAttachmentSaveName('../folder\\evil\r.txt')).toBe('evil_.txt')
    expect(Buffer.byteLength(safeAttachmentSaveName('😀'.repeat(100) + '.txt'))).toBeLessThanOrEqual(180)
    expect(safeAttachmentSaveName('...')).toBe('attachment-1')
  })

  test('keeps existing files and duplicate names intact inside the chosen directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jefi-save-'))
    directories.push(directory)
    const source = join(directory, 'source.bin')
    const existing = join(directory, 'report.txt')
    writeFileSync(source, 'new')
    writeFileSync(existing, 'old')

    const first = await saveAttachmentInDirectory(source, directory, '../../report.txt')
    const second = await saveAttachmentInDirectory(source, directory, '..\\..\\report.txt')

    expect(readFileSync(existing, 'utf8')).toBe('old')
    expect(readFileSync(first, 'utf8')).toBe('new')
    expect(readFileSync(second, 'utf8')).toBe('new')
    expect(first).not.toBe(second)
    expect(dirname(first)).toBe(directory)
    expect(dirname(second)).toBe(directory)
  })
})
