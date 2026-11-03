import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ATTACHMENT_BYTES, describeFile, fileBytes, fileProblemMessage, formatSize, overAttachmentLimit, readProblem, totalAttachmentBytes } from './attachment-files'

const dir = mkdtempSync(join(tmpdir(), 'jefi-attach-files-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const file = (name: string, bytes: number) => {
  const path = join(dir, name)
  writeFileSync(path, Buffer.alloc(bytes, 0x61))
  return path
}

test('sizes read the way the reader writes them', () => {
  expect(formatSize(0)).toBe('0 B')
  expect(formatSize(512)).toBe('512 B')
  expect(formatSize(1024)).toBe('1 KB')
  expect(formatSize(1536)).toBe('2 KB')
  expect(formatSize(2 * 1024 * 1024)).toBe('2.0 MB')
})

test('a picked file becomes an attachment with its name, size and path', () => {
  const path = file('Design Tokens.json', 2048)
  expect(describeFile(path)).toEqual({ name: 'Design Tokens.json', size: '2 KB', path })
})

test('a file that is not there counts as no bytes rather than throwing', () => {
  expect(fileBytes(join(dir, 'never-existed'))).toBe(0)
  expect(describeFile(join(dir, 'never-existed')).size).toBe('0 B')
})

test('a readable file has no problem to report', () => {
  expect(readProblem(file('readable.txt', 8))).toBeNull()
})

test('a file that is gone reads as moved or deleted', () => {
  const path = join(dir, 'vanished.txt')
  expect(readProblem(path)).toBe('missing')
  expect(fileProblemMessage('vanished.txt', 'missing')).toBe("Couldn't read vanished.txt — it may have been moved or deleted")
})

// Root reads anything, so the mode wouldn't prove a thing.
const unlessRoot = process.getuid?.() === 0 ? test.skip : test
unlessRoot('a file that cannot be opened reads as refused, not as gone', () => {
  const path = file('private.txt', 8)
  chmodSync(path, 0o000)
  try {
    expect(readProblem(path)).toBe('denied')
    expect(fileProblemMessage('private.txt', 'denied')).toBe(
      "Jefi isn't allowed to read private.txt. Allow it in System Settings → Privacy & Security → Files and Folders, then send again.",
    )
  } finally {
    chmodSync(path, 0o600)
  }
})

test('the total is what has to stay under the limit, not each file', () => {
  const half = MAX_ATTACHMENT_BYTES / 2
  const first = describeFile(file('first.bin', half))
  const second = describeFile(file('second.bin', half + 1))
  expect(totalAttachmentBytes([first])).toBe(half)
  expect(overAttachmentLimit([first])).toBe(false)
  expect(overAttachmentLimit([first, second])).toBe(true)
  // Mail from the server has no path: nothing to weigh.
  expect(totalAttachmentBytes([{ name: 'q3.csv', size: '3 B' }])).toBe(0)
})
