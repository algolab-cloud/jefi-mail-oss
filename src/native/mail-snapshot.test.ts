import { expect, test } from 'bun:test'
import { mailSnapshotHelperPath, pngDataUrl } from './mail-snapshot'

test('mail snapshot helper lives beside a packaged executable and in the development build cache', () => {
  expect(mailSnapshotHelperPath('/Applications/Jefi.app/Contents/MacOS/Jefi', '/repo')).toBe(
    '/Applications/Jefi.app/Contents/Frameworks/libJefiMailSnapshot.dylib',
  )
  expect(mailSnapshotHelperPath('/opt/bun/bin/bun', '/repo')).toBe('/repo/build/native/libJefiMailSnapshot.dylib')
})

test('borrowed native bytes become a validated copied PNG data URL', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  expect(pngDataUrl(png)).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`)
  expect(pngDataUrl(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeNull()
  expect(pngDataUrl(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull()
})
