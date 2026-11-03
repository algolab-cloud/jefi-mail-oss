import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// GPUIX paints an opaque #1A1A1A fill behind an <anchored> element that has no background of its
// own, which shows as dark corners around a rounded popover. Every <anchored> must carry the same
// backgroundColor and borderRadius as the card inside it.
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : []
  })

test('every <anchored> popover sets its own background and radius', () => {
  const missing: string[] = []
  for (const file of files(join(import.meta.dir))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/<anchored\b[^>]*>/g)) {
      if (!/style=\{\{[^}]*backgroundColor[^}]*borderRadius|style=\{\{[^}]*borderRadius[^}]*backgroundColor/.test(match[0])) missing.push(`${file}: ${match[0].slice(0, 80)}`)
    }
  }
  expect(missing).toEqual([])
})
