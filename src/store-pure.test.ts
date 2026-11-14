import { expect, test } from 'bun:test'
import { droppedChangeMessage } from './store-pure'

test('changes given up on are reported by what they were, and as restored', () => {
  expect(droppedChangeMessage({ kind: 'move', folder: 'archive', count: 3 })).toBe("Couldn't archive 3 messages — restored")
  expect(droppedChangeMessage({ kind: 'move', folder: 'trash', count: 1 })).toBe("Couldn't move 1 message to Trash — restored")
  expect(droppedChangeMessage({ kind: 'move', count: 2 })).toBe("Couldn't move 2 messages — restored")
  expect(droppedChangeMessage({ kind: 'delete', count: 2 })).toBe("Couldn't delete 2 messages — restored")
  expect(droppedChangeMessage({ kind: 'flags', count: 1 })).toBe("Couldn't update 1 message — restored")
})
