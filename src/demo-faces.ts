import type { FaceSpec } from './data'

/**
 * Demo mode only: with JEFI_DEMO_FACES=<dir>, a sender whose `<email>.jpg` exists in that folder
 * shows that photo instead of initials. Used by `bun run demo` and screenshots; real users never set it.
 */
const dir = typeof process !== 'undefined' ? process.env.JEFI_DEMO_FACES : undefined
const cache = new Map<string, string | null>()

function photoFor(email: string): string | null {
  const key = email.toLowerCase()
  if (cache.has(key)) return cache.get(key)!
  let src: string | null = null
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const file = `${dir}/${key}.jpg`
    if (fs.existsSync(file)) src = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    src = null
  }
  cache.set(key, src)
  return src
}

export function withDemoFace(email: string | undefined, face: FaceSpec): FaceSpec {
  if (!dir || !email) return face
  const src = photoFor(email)
  return src ? { ...face, src } : face
}
