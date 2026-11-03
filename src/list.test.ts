import { describe, expect, test } from 'bun:test'
import { bulkActionFor, rowPlacement } from './list'

describe('mail keys with conversations checked', () => {
  const picked = { anyUnread: true, allStarred: false, inTrash: false }

  test('E, #, S and U act on the selection', () => {
    expect(bulkActionFor('archive', picked)).toEqual({ move: 'archive' })
    expect(bulkActionFor('trash', picked)).toEqual({ move: 'trash' })
    expect(bulkActionFor('star', picked)).toEqual({ starred: true })
    expect(bulkActionFor('star', { ...picked, allStarred: true })).toEqual({ starred: false })
    expect(bulkActionFor('unread', picked)).toEqual({ unread: false })
    expect(bulkActionFor('unread', { ...picked, anyUnread: false })).toEqual({ unread: true })
  })

  test('# in the Trash is swallowed rather than deleting for good', () => {
    expect(bulkActionFor('trash', { ...picked, inTrash: true })).toBeNull()
  })

  test('moving around and writing keys are left to the reader', () => {
    for (const action of ['next', 'previous', 'reply', 'forward', 'compose', 'goInbox'] as const) expect(bulkActionFor(action, picked)).toBeUndefined()
  })
})

describe('rowPlacement', () => {
  // A day heading, then rows of 68px, in a 300px viewport.
  const heights = [27, 68, 68, 68, 68, 68, 68, 68]

  test('rows inside the viewport are left where they are', () => {
    expect(rowPlacement(heights, 1, { index: 0, offset: 0, viewport: 300 })).toBe('visible')
    expect(rowPlacement(heights, 3, { index: 0, offset: 0, viewport: 300 })).toBe('visible')
  })

  test('a row cut off at the bottom, or past it, is below', () => {
    expect(rowPlacement(heights, 4, { index: 0, offset: 0, viewport: 300 })).toBe('visible')
    expect(rowPlacement(heights, 5, { index: 0, offset: 0, viewport: 300 })).toBe('below')
    expect(rowPlacement(heights, 4, { index: 0, offset: 0, viewport: 290 })).toBe('below')
    expect(rowPlacement(heights, 7, { index: 0, offset: 0, viewport: 300 })).toBe('below')
  })

  test('a row scrolled past, or partly under the top edge, is above', () => {
    expect(rowPlacement(heights, 1, { index: 3, offset: 0, viewport: 300 })).toBe('above')
    expect(rowPlacement(heights, 3, { index: 3, offset: 10, viewport: 300 })).toBe('above')
    expect(rowPlacement(heights, 4, { index: 3, offset: 10, viewport: 300 })).toBe('visible')
  })
})
