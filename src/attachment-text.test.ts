import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { attachmentKind, attachmentText, clipText, htmlText } from './attachment-text'

test('the assistant reads text, HTML, PDFs and documents, and says which files it cannot', async () => {
  expect(['notes.TXT', 'page.html', 'contract.pdf', 'brief.docx', 'photo.jpg', 'noext'].map(attachmentKind)).toEqual(['plain', 'html', 'pdf', 'document', null, null])
  await expect(attachmentText('/nonexistent', 'photo.jpg')).rejects.toThrow("isn't a kind of file the assistant can read")
})

test('HTML comes through as its visible text', () => {
  expect(htmlText('<html><head><title>x</title></head><style>p{}</style><p>Total: &amp; <b>$420</b></p><script>alert(1)</script><p>Due Friday</p>')).toBe('Total: & $420\nDue Friday')
})

test('long text is cut off, and says so', () => {
  expect(clipText('a\r\n\n\n\nb')).toBe('a\n\nb')
  expect(clipText('abcdefghij', 4)).toBe("abcd\n\n[Cut off: the rest of the file (6 more characters) isn't shown]")
})

test('a text file and an empty one', async () => {
  const dir = mkdtempSync(`${tmpdir()}/jefi-attachment-`)
  try {
    writeFileSync(`${dir}/a.csv`, 'item,total\nbudget,420\n')
    writeFileSync(`${dir}/empty.txt`, '  \n')
    expect(await attachmentText(`${dir}/a.csv`, 'a.csv')).toBe('item,total\nbudget,420')
    await expect(attachmentText(`${dir}/empty.txt`, 'empty.txt')).rejects.toThrow('has no text in it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
