import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// GPUIX delivers Enter in a single-line <input> as onSubmit, never as onKeyDown, so an Enter check in
// an input's onKeyDown silently does nothing (the reader's "New label…" and find bar did just that).
const FILES = ['reading.tsx', 'reader-tools-ui.tsx', 'sidebar.tsx', 'list.tsx']

/** Every `<input … />` element's source text. */
const inputs = (source: string) => [...source.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0])

describe('mail inputs', () => {
  for (const file of FILES) {
    test(`${file}: Enter is handled with onSubmit`, () => {
      for (const input of inputs(readFileSync(`${import.meta.dir}/${file}`, 'utf8'))) {
        expect(input).not.toMatch(/key === ['"]enter['"]/)
      }
    })
  }
})
