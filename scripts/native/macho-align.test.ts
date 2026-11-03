import { describe, expect, test } from 'bun:test'
import { alignStringTable } from './macho-align'

/** A minimal 64-bit Mach-O: header, __LINKEDIT and LC_SYMTAB, with the string table last at `stroff`. */
function image(stroff: number, strings = 'abc\0') {
  const file = Buffer.alloc(stroff + strings.length)
  file.writeUInt32LE(0xfeedfacf, 0)
  file.writeUInt32LE(2, 16) // ncmds
  let at = 32
  file.writeUInt32LE(0x19, at) // LC_SEGMENT_64
  file.writeUInt32LE(72, at + 4)
  file.write('__LINKEDIT', at + 8, 'latin1')
  file.writeBigUInt64LE(BigInt(stroff - 8), at + 40) // fileoff
  file.writeBigUInt64LE(BigInt(8 + strings.length), at + 48) // filesize
  at += 72
  file.writeUInt32LE(0x2, at) // LC_SYMTAB
  file.writeUInt32LE(24, at + 4)
  file.writeUInt32LE(stroff, at + 16)
  file.writeUInt32LE(strings.length, at + 20)
  file.write(strings, stroff, 'latin1')
  return file
}

describe('alignStringTable', () => {
  test('pads a 4-aligned string table onto an 8-byte boundary', () => {
    const out = alignStringTable(image(196))!
    expect(out.readUInt32LE(104 + 16)).toBe(200)
    expect(out.toString('latin1', 200, 204)).toBe('abc\0')
    expect(out.readBigUInt64LE(32 + 48)).toBe(16n)
    expect(out.length).toBe(204)
  })

  test('leaves an aligned image alone', () => {
    expect(alignStringTable(image(200))).toBeNull()
  })

  test('moves the table into zero padding after it, without growing the file', () => {
    // Xcode 16's linker pads the image after the string table.
    const padded = Buffer.concat([image(196), Buffer.alloc(8)])
    padded.writeBigUInt64LE(20n, 32 + 48) // __LINKEDIT covers the padding
    const out = alignStringTable(padded)!
    expect(out.readUInt32LE(104 + 16)).toBe(200)
    expect(out.toString('latin1', 200, 204)).toBe('abc\0')
    expect(out.length).toBe(208)
    expect(out.readBigUInt64LE(32 + 48)).toBe(20n)
  })

  test('grows the file and __LINKEDIT by what the padding behind cannot cover', () => {
    const out = alignStringTable(Buffer.concat([image(196), Buffer.alloc(2)]))!
    expect(out.readUInt32LE(104 + 16)).toBe(200)
    expect(out.length).toBe(204)
    expect(out.readBigUInt64LE(32 + 48)).toBe(16n)
  })

  test('refuses an image with data after its string table', () => {
    expect(() => alignStringTable(Buffer.concat([image(196), Buffer.from([1, 0, 0, 0])]))).toThrow('not the last')
  })
})
