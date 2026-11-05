import { expect, test } from 'bun:test'
import { contentHeight, mailSnapshotHelperPath, pngDataUrl } from './mail-snapshot'

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

test('a measured content height is used only when it is a real size', () => {
  expect(contentHeight(412.4)).toBe(413)
  for (const bad of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000]) expect(contentHeight(bad)).toBeNull()
})
