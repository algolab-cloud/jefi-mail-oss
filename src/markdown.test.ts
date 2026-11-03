import { describe, expect, test } from 'bun:test'
import { linkifyPlainText, plainTextMarkdown } from './markdown'

describe('plain message links', () => {
  test('makes web and mailto URLs clickable without interpreting surrounding Markdown', () => {
    expect(linkifyPlainText('**literal** https://example.com/a?b=1 mailto:help@example.com')).toBe(
      '\\*\\*literal\\*\\* <https://example.com/a?b=1> <mailto:help@example.com>',
    )
  })

  test('keeps sentence punctuation outside the destination', () => {
    expect(linkifyPlainText('Visit https://example.com/path, then reply.')).toBe(
      'Visit <https://example.com/path>, then reply\\.',
    )
  })

  test('preserves plain list blocks as lists after escaping their contents', () => {
    expect(plainTextMarkdown(['one *literal*', 'two https://example.com'])).toBe(
      '- one \\*literal\\*\n- two <https://example.com>',
    )
  })

  test('preserves deliberate single line breaks in plain paragraphs', () => {
    expect(plainTextMarkdown('first line\nsecond line')).toBe('first line  \nsecond line')
  })
})
