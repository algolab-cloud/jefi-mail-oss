import { expect, test } from 'bun:test'
import { copySelectionOnKey } from './copy-selection'

test('⌘C copies the selected text, and leaves the key to a focused field or plain C', () => {
  const copied: string[] = []
  const copy = (text: string) => (copied.push(text), true)
  const page = (selected: string | null, focused: string | null = null) => ({ getSelectedText: () => selected, getFocusedElementId: () => focused })
  const cmdC = { key: 'c', modifiers: { cmd: true } }

  expect(copySelectionOnKey(cmdC, page('Wells of Life’s order is on hold.'), copy)).toBe(true)
  expect(copySelectionOnKey({ key: 'C', modifiers: { cmd: true } }, page('Again'), copy)).toBe(true)
  expect(copySelectionOnKey(cmdC, page('In the composer', 'reply-input'), copy)).toBe(false)
  expect(copySelectionOnKey(cmdC, page(null), copy)).toBe(false)
  expect(copySelectionOnKey(cmdC, page('   '), copy)).toBe(false)
  expect(copySelectionOnKey({ key: 'c' }, page('Typed c'), copy)).toBe(false)
  expect(copySelectionOnKey({ key: 'c', modifiers: { cmd: true, shift: true } }, page('Shifted'), copy)).toBe(false)
  expect(copied).toEqual(['Wells of Life’s order is on hold.', 'Again'])
})
