import { describe, expect, test } from 'bun:test'
import { chunkMarkdown, splitQuoted } from './mail-text'

describe('splitQuoted', () => {
  test('folds the trailing quote and its attribution line', () => {
    const md = 'Sounds good.\n\nOn Mon, 3 Mar 2026, Ada <ada@x.com> wrote:\n\n> Earlier text\n>\n> > Even earlier'
    expect(splitQuoted(md)).toEqual({ body: 'Sounds good.', quoted: 'On Mon, 3 Mar 2026, Ada <ada@x.com> wrote:\n\n> Earlier text\n>\n> > Even earlier' })
  })
  test('keeps a quote that has new text after it', () => {
    const md = '> Your question\n\nMy answer'
    expect(splitQuoted(md)).toEqual({ body: md, quoted: null })
  })
  test('shows a message that is only a quote', () => {
    expect(splitQuoted('> forwarded text')).toEqual({ body: '> forwarded text', quoted: null })
  })
  test('no quote at all', () => {
    expect(splitQuoted('Hello\n\nThanks')).toEqual({ body: 'Hello\n\nThanks', quoted: null })
  })
})

describe('chunkMarkdown', () => {
  test('cuts at blank lines into pieces of about the given size', () => {
    const md = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'x'.repeat(40)}`).join('\n\n')
    const chunks = chunkMarkdown(md, 100)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.join('\n\n')).toBe(md)
  })
  test('never cuts inside a fenced code block', () => {
    const md = ['intro', '```', 'line one', '', 'line two', '```', 'after'].join('\n')
    const chunks = chunkMarkdown(md, 1)
    expect(chunks.some((c: string) => c.includes('line one') && c.includes('line two'))).toBe(true)
  })
})
