import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A GPUIX <input> reports Enter as onSubmit, never as a keydown, so an `event.key === 'enter'` check
// in an input's onKeyDown never runs: the event editor's title, time and guests fields and the
// reader's quick add all ignored Enter that way. (⌘↩ does arrive as a keydown, so such a check also
// doubled the editor's own ⌘↩ save.)
const src = join(import.meta.dir, '..')
const sources = [
  ...['calendar', 'reader-calendar'].flatMap((dir) =>
    readdirSync(join(src, dir))
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => ({ file: `${dir}/${name}`, source: readFileSync(join(src, dir, name), 'utf8') })),
  ),
  // The shared field the reader's quick add is built from.
  (() => {
    const source = readFileSync(join(src, 'ui.tsx'), 'utf8')
    const start = source.indexOf('export function TextInput(')
    return { file: 'ui.tsx TextInput', source: source.slice(start, source.indexOf('\nexport ', start + 1)) }
  })(),
]

test('calendar inputs handle Enter in onSubmit, not onKeyDown', () => {
  const offenders: string[] = []
  for (const { file, source } of sources) {
    for (const match of source.matchAll(/<input\b[\s\S]*?\/>/g)) {
      const keyDown = /onKeyDown=\{[\s\S]*?\n\s*\}\}/.exec(match[0])?.[0] ?? ''
      if (/===\s*['"]enter['"]/.test(keyDown)) offenders.push(`${file}: ${match[0].slice(0, 60)}`)
    }
  }
  expect(offenders).toEqual([])
})
