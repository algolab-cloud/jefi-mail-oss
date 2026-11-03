import { describe, expect, test } from 'bun:test'
import { composeFormatEdit, shortcutFormat, validEditorSelection } from './compose-format'

describe('compose formatting edits', () => {
  test('wraps the exact selected duplicate rather than searching by text', () => {
    const value = 'same and same'
    expect(composeFormatEdit(value, { location: 9, length: 4 }, { kind: 'inline', before: '**', after: '**', placeholder: 'bold' })).toEqual({
      range: { location: 9, length: 4 },
      text: '**same**',
    })
  })

  test('uses UTF-16 Cocoa offsets without splitting emoji', () => {
    const value = 'Hi 😃 there'
    expect(composeFormatEdit(value, { location: 3, length: 2 }, { kind: 'inline', before: '_', after: '_', placeholder: 'italic' })?.text).toBe('_😃_')
    expect(validEditorSelection(value, { location: 4, length: 0 })).toBe(false)
  })

  test('inserts a placeholder at the exact collapsed caret', () => {
    expect(composeFormatEdit('beforeafter', { location: 6, length: 0 }, { kind: 'inline', before: '`', after: '`', placeholder: 'code' })).toEqual({
      range: { location: 6, length: 0 },
      text: '`code`',
    })
  })

  test('prefixes every touched selected line and the current caret line', () => {
    expect(composeFormatEdit('zero\none\ntwo\nthree', { location: 5, length: 7 }, { kind: 'line', prefix: '- ', placeholder: 'Item' })).toEqual({
      range: { location: 5, length: 7 },
      text: '- one\n- two',
    })
    expect(composeFormatEdit('one\ntwo', { location: 6, length: 0 }, { kind: 'line', prefix: '> ', placeholder: 'Quote' })).toEqual({
      range: { location: 4, length: 3 },
      text: '> two',
    })
    expect(composeFormatEdit('\none', { location: 0, length: 0 }, { kind: 'line', prefix: '- ', placeholder: 'Item' })).toEqual({
      range: { location: 0, length: 0 },
      text: '- Item',
    })
    expect(composeFormatEdit('one\ntwo', { location: 0, length: 4 }, { kind: 'line', prefix: '> ', placeholder: 'Quote' })).toEqual({
      range: { location: 0, length: 4 },
      text: '> one\n',
    })
  })

  test('maps only supported modifier shortcuts', () => {
    expect(shortcutFormat({ key: 'b', modifiers: { cmd: true, ctrl: false, shift: false } }, 'darwin')).toMatchObject({ before: '**' })
    expect(shortcutFormat({ key: 'k', modifiers: { cmd: false, ctrl: true, shift: false } }, 'other')).toMatchObject({ after: '](https://)' })
    expect(shortcutFormat({ key: 'x', modifiers: { cmd: true, ctrl: false, shift: true } }, 'darwin')).toMatchObject({ before: '~~' })
    expect(shortcutFormat({ key: 'b', modifiers: { cmd: false, ctrl: false, shift: false } })).toBeNull()
    expect(shortcutFormat({ key: 'b', modifiers: { cmd: false, ctrl: true, shift: false } }, 'darwin')).toBeNull()
    expect(shortcutFormat({ key: 'b', modifiers: { cmd: true, ctrl: false, shift: false } }, 'other')).toBeNull()
    expect(shortcutFormat({ key: 'x', modifiers: { cmd: false, ctrl: true, shift: true } }, 'other')).toMatchObject({ before: '~~' })
    expect(shortcutFormat({ key: 'l', modifiers: { cmd: true, ctrl: false, shift: true } }, 'darwin')).toMatchObject({ kind: 'line', prefix: '- [ ] ' })
    expect(shortcutFormat({ key: 'l', modifiers: { cmd: true, ctrl: false, shift: false } }, 'darwin')).toBeNull()
  })
})
