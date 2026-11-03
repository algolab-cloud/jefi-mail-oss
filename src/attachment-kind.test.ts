import { describe, expect, test } from 'bun:test'
import { fileExtension, fileKind, middleEllipsis } from './attachment-kind'

describe('middleEllipsis', () => {
  test('leaves short names alone', () => {
    expect(middleEllipsis('a.pdf', 26)).toBe('a.pdf')
    expect(middleEllipsis('x'.repeat(26), 26)).toBe('x'.repeat(26))
  })

  test('cuts from the middle and keeps the extension', () => {
    const short = middleEllipsis('Q3-board-presentation-final-v7-approved.pptx', 26)
    expect(short).toBe('Q3-board-present…oved.pptx')
    expect([...short].length).toBe(26)
  })

  test('names without an extension keep a bit of both ends', () => {
    const short = middleEllipsis('a-very-long-name-without-any-extension-at-all', 20)
    expect([...short].length).toBe(20)
    expect(short.startsWith('a-very-long')).toBe(true)
    expect(short.endsWith('all')).toBe(true)
  })

  test('never gives the tail more than half the room', () => {
    expect(middleEllipsis('abcdefghijkl.jpeg', 9)).toBe('abcd…jpeg')
    expect([...middleEllipsis('abcdefghijkl.jpeg', 9)].length).toBe(9)
  })

  test('counts characters, not UTF-16 units', () => {
    expect(middleEllipsis('📎📎📎📎📎📎📎📎📎📎.pdf', 10)).toBe('📎📎📎📎📎….pdf')
  })

  test('tiny limits still return something', () => {
    expect(middleEllipsis('report.pdf', 1)).toBe('…')
  })
})

describe('fileKind', () => {
  test.each([
    ['a.pdf', 'pdf', 'PDF', 'PDF'],
    ['Letter.DOCX', 'document', 'DOCX', 'Document'],
    ['numbers.xlsx', 'spreadsheet', 'XLSX', 'Spreadsheet'],
    ['export.csv', 'spreadsheet', 'CSV', 'Spreadsheet'],
    ['deck.pptx', 'presentation', 'PPTX', 'Presentation'],
    ['assets.zip', 'archive', 'ZIP', 'Archive'],
    ['photo.jpeg', 'image', 'JPEG', 'Image'],
    ['voice.m4a', 'audio', 'M4A', 'Audio'],
    ['clip.mov', 'video', 'MOV', 'Video'],
    ['invite.ics', 'calendar', 'ICS', 'Calendar'],
    ['notes.txt', 'text', 'TXT', 'Text'],
    ['config.json', 'code', 'JSON', 'Code'],
    ['blob.bin', 'generic', 'BIN', 'File'],
  ] as const)('%s → %s', (name, family, label, typeName) => {
    expect(fileKind(name)).toEqual({ family, label, typeName })
  })

  test('no extension, or one too long to be a type, gets no label', () => {
    expect(fileKind('README')).toEqual({ family: 'generic', label: '', typeName: 'File' })
    expect(fileKind('.env').label).toBe('')
    expect(fileKind('scan.version2').label).toBe('')
  })

  test('fileExtension ignores leading and trailing dots', () => {
    expect(fileExtension('.bashrc')).toBe('')
    expect(fileExtension('file.')).toBe('')
    expect(fileExtension('archive.tar.gz')).toBe('gz')
  })
})
