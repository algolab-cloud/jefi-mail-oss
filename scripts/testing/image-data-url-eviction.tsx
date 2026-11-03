import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createTestRoot } from '@gpuix/react/testing'
import { imageDataUrlReleaseVersion } from '@gpuix/native'

type CacheState = { assetCached: boolean; atlasCached: boolean }
type NativeImageTestRenderer = {
  releaseImageDataUrl(src: string): boolean
  inspectImageDataUrlCache(src: string): CacheState | null
  takePendingImageReleaseTestResult(): [boolean, boolean] | null
}

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

const chunk = (name: string, data: Uint8Array) => {
  const type = Buffer.from(name, 'ascii')
  const body = Buffer.from(data)
  const result = Buffer.allocUnsafe(12 + body.length)
  result.writeUInt32BE(body.length, 0)
  type.copy(result, 4)
  body.copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([type, body])), 8 + body.length)
  return result
}

const pngDataUrl = (red: number, green: number, blue: number) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 8
  header[9] = 6
  const row = [0, red, green, blue, 255, red, green, blue, 255]
  const pixels = Buffer.from([...row, ...row])
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

const root = createTestRoot({ width: 220, height: 160 })
const native = (root.renderer as unknown as { native: NativeImageTestRenderer }).native
const proofDirectory = resolve('tmp')
mkdirSync(proofDirectory, { recursive: true })

const renderImage = (src: string | null, releasePendingDecode = false) => {
  const testProps = releasePendingDecode ? { testReleasePendingDecode: true } : {}
  root.render(
    <div style={{ width: 220, height: 160, padding: 12, backgroundColor: '#111827' }}>
      {src ? <img {...testProps} src={src} alt="transient snapshot" style={{ width: 96, height: 96 }} /> : null}
    </div>,
  )
  root.renderer.flush()
  // Force the offscreen Metal surface to submit the painted frame. Layout
  // alone populates the decoded asset cache but does not upload atlas tiles.
  root.renderer.captureScreenshot(resolve(proofDirectory, 'image-data-url-eviction.png'))
}

const expectState = (src: string, expected: CacheState, label: string) => {
  assert.deepEqual(native.inspectImageDataUrlCache(src), expected, label)
}

assert.equal(imageDataUrlReleaseVersion(), 1)
assert.equal(native.releaseImageDataUrl('https://example.test/image.png'), false, 'network images are never evicted by the data-URL API')
assert.equal(native.inspectImageDataUrlCache('not a data URL'), null)

try {
  const early = pngDataUrl(7, 19, 31)
  renderImage(early, true)
  assert.deepEqual(native.takePendingImageReleaseTestResult(), [true, true], 'early dismissal should observe and remove a pending decoder task during render')
  // renderImage has already parked the dispatcher after the removal. A late
  // decoder completion must not put the task or pixels back into either cache.
  expectState(early, { assetCached: false, atlasCached: false }, 'a later dispatcher pump must not reinsert the dismissed image')
  renderImage(null)

  const sources = Array.from({ length: 8 }, (_, index) =>
    pngDataUrl(40 + index * 19, 90 + index * 11, 180 - index * 13))

  for (const [index, src] of sources.entries()) {
    renderImage(src)
    expectState(src, { assetCached: true, atlasCached: true }, `image ${index} should reach both caches after paint`)

    assert.equal(native.releaseImageDataUrl(src), false, 'a mounted image must be protected from eviction')
    expectState(src, { assetCached: true, atlasCached: true }, 'a refused release must keep the live image intact')

    renderImage(null)
    assert.equal(native.releaseImageDataUrl(src), true, `image ${index} should be released after unmount`)
    expectState(src, { assetCached: false, atlasCached: false }, `image ${index} must leave neither cache behind`)
  }

  // Recheck every prior source after later frames have painted. This catches a
  // detached decoder or stale frame that repopulates a cache after dismissal.
  const finalStates = sources.map((src) => native.inspectImageDataUrlCache(src))
  assert(finalStates.every((state) => state?.assetCached === false && state.atlasCached === false),
    'released images must stay absent after later dispatcher and paint cycles')

  console.log(JSON.stringify({
    marker: imageDataUrlReleaseVersion(),
    earlyDismiss: 'pending asset removed before decode',
    uniqueImagesReleased: sources.length,
    finalStates,
  }, null, 2))
} finally {
  root.unmount()
}
