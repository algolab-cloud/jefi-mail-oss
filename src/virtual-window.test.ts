import { expect, test } from 'bun:test'
import { OVERDRAW, WINDOW, rowPlacement, windowFor } from './virtual-window'

test('a reported range mounts it with overdraw, never less than a screenful', () => {
  expect(windowFor({ startIndex: 0, endIndex: 10 })).toEqual({ start: 0, end: WINDOW })
  expect(windowFor({ startIndex: 100, endIndex: 130 })).toEqual({ start: 100 - OVERDRAW, end: Math.max(100 - OVERDRAW + WINDOW, 130 + OVERDRAW) })
  expect(windowFor({})).toEqual({ start: 0, end: WINDOW })
})

test('rowPlacement finds rows above, in and below the viewport', () => {
  const h = (i: number) => (i === 0 ? 38 : 44)
  const top = { index: 2, offset: 10, viewport: 200 }
  expect(rowPlacement(h, 1, top)).toBe('above')
  expect(rowPlacement(h, 2, top)).toBe('above')
  expect(rowPlacement(h, 3, top)).toBe('visible')
  expect(rowPlacement(h, 6, top)).toBe('below')
})
