// ---------------------------------------------------------------------------
// macOS 27's dyld refuses a Mach-O whose symbol string table doesn't start on an 8-byte boundary
// ("mis-aligned LINKEDIT string pool"), and ld-27xxx can leave it 4-aligned. The table is the last
// thing in __LINKEDIT once the code signature is gone, so it can be moved by padding in front of it.
// Older linkers (Xcode 16) leave zero padding after it, which the move uses up first.
// ---------------------------------------------------------------------------

const MH_MAGIC_64 = 0xfeedfacf
const LC_SYMTAB = 0x2
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

/**
 * The image with its string table moved onto an 8-byte boundary, or null when it already is.
 * Expects an unsigned 64-bit Mach-O: sign it again afterwards.
 */
export function alignStringTable(file: Buffer): Buffer | null {
  if (file.readUInt32LE(0) !== MH_MAGIC_64) throw new Error('Not a 64-bit Mach-O image.')
  let at = 32
  let symtab = -1
  let linkedit = -1
  for (let i = 0, count = file.readUInt32LE(16); i < count; i++) {
    const command = file.readUInt32LE(at)
    if (command === LC_CODE_SIGNATURE) throw new Error('Remove the code signature before aligning the string table.')
    if (command === LC_SYMTAB) symtab = at
    if (command === LC_SEGMENT_64 && file.toString('latin1', at + 8, at + 24).replace(/\0+$/, '') === '__LINKEDIT') linkedit = at
    at += file.readUInt32LE(at + 4)
  }
  if (symtab < 0 || linkedit < 0) throw new Error('Mach-O image has no symbol table or __LINKEDIT segment.')
  const offset = file.readUInt32LE(symtab + 16)
  const pad = (8 - (offset % 8)) % 8
  if (!pad) return null
  const end = offset + file.readUInt32LE(symtab + 20)
  const tail = file.subarray(end)
  if (tail.some((byte) => byte !== 0)) throw new Error(`The string table is not the last thing in the image (${tail.length} bytes of data follow it).`)
  // Padding in front, taken out of the zeros behind; the file grows only by what they can't cover.
  const out = Buffer.concat([file.subarray(0, offset), Buffer.alloc(pad), file.subarray(offset, end), tail.subarray(Math.min(pad, tail.length))])
  out.writeUInt32LE(offset + pad, symtab + 16)
  const segmentEnd = out.readBigUInt64LE(linkedit + 40) + out.readBigUInt64LE(linkedit + 48)
  const tableEnd = BigInt(end + pad)
  if (segmentEnd < tableEnd) out.writeBigUInt64LE(out.readBigUInt64LE(linkedit + 48) + tableEnd - segmentEnd, linkedit + 48)
  return out
}
