import { expect, test } from 'bun:test'
import { PREFIX_TIMEOUT_MS, SHORTCUTS, hintFor, shortcutFor, shortcutList, type Prefix, type ShortcutAction, type ShortcutContext } from './shortcuts'

const context = (over: Partial<ShortcutContext> = {}): ShortcutContext => ({ typing: false, busy: false, prefix: null, now: 1000, ...over })

const action = (key: string, over: Partial<ShortcutContext> = {}, modifiers?: { shift?: boolean; cmd?: boolean; ctrl?: boolean; alt?: boolean }) =>
  shortcutFor({ key, modifiers }, context(over))?.action

test('one key, one action', () => {
  expect(action('j')).toBe('next')
  expect(action('down')).toBe('next')
  expect(action('k')).toBe('previous')
  expect(action('up')).toBe('previous')
  expect(action('enter')).toBe('open')
  expect(action('e')).toBe('archive')
  expect(action('backspace')).toBe('trash')
  expect(action('r')).toBe('reply')
  expect(action('a')).toBe('replyAll')
  expect(action('f')).toBe('forward')
  expect(action('c')).toBe('compose')
  expect(action('s')).toBe('star')
  expect(action('u')).toBe('unread')
  expect(action('/')).toBe('search')
  expect(action('?')).toBe('help')
})

test('shifted keys arrive either as the character or as the unshifted key', () => {
  expect(action('?')).toBe('help')
  expect(action('/', {}, { shift: true })).toBe('help')
  expect(action('#')).toBe('trash')
  expect(action('3', {}, { shift: true })).toBe('trash')
  // Unshifted, 3 is just a digit.
  expect(shortcutFor({ key: '3' }, context())).toBeNull()
})

test('a letter typed into a field or under an overlay is not a shortcut', () => {
  expect(shortcutFor({ key: 'j' }, context({ typing: true }))).toBeNull()
  expect(shortcutFor({ key: 'r' }, context({ busy: true }))).toBeNull()
  // Not even the second half of a mailbox jump.
  expect(shortcutFor({ key: 'i' }, context({ typing: true, prefix: { key: 'g', at: 1000 } }))).toBeNull()
})

test('the command key belongs to the menus', () => {
  expect(shortcutFor({ key: 'j', modifiers: { cmd: true } }, context())).toBeNull()
  expect(shortcutFor({ key: 'k', modifiers: { ctrl: true } }, context())).toBeNull()
  expect(shortcutFor({ key: 'c', modifiers: { alt: true } }, context())).toBeNull()
})

test('g then a letter jumps to a mailbox', () => {
  const first = shortcutFor({ key: 'g' }, context())!
  expect(first.action).toBeUndefined()
  expect(first.prefix).toEqual({ key: 'g', at: 1000 })

  const jumps: Array<[string, ShortcutAction]> = [
    ['i', 'goInbox'],
    ['s', 'goStarred'],
    ['d', 'goDrafts'],
    ['t', 'goSent'],
  ]
  for (const [key, expected] of jumps) {
    const second = shortcutFor({ key }, context({ prefix: first.prefix, now: 1500 }))!
    expect(second.action).toBe(expected)
    expect(second.prefix).toBeNull()
  }
})

test('a g left hanging expires, and any other key cancels it and counts on its own', () => {
  const prefix: Prefix = { key: 'g', at: 1000 }
  // Past the timeout, `s` is Star again rather than Starred.
  expect(action('s', { prefix, now: 1000 + PREFIX_TIMEOUT_MS + 1 })).toBe('star')
  expect(action('s', { prefix, now: 1000 + PREFIX_TIMEOUT_MS })).toBe('goStarred')
  // A key that means nothing after g falls through to its own meaning.
  const cancelled = shortcutFor({ key: 'j' }, context({ prefix, now: 1100 }))!
  expect(cancelled.action).toBe('next')
  expect(cancelled.prefix).toBeNull()
  // A key that means nothing at all still clears the g.
  expect(shortcutFor({ key: 'q' }, context({ prefix, now: 1100 }))).toEqual({ prefix: null })
  expect(shortcutFor({ key: 'q' }, context())).toBeNull()
})

test('every shortcut in the cheat sheet has keys, and the palette can find them', () => {
  expect(SHORTCUTS.every((s) => s.keys && s.label && s.group)).toBe(true)
  expect(hintFor('goInbox')).toBe('G I')
  expect(new Set(SHORTCUTS.map((s) => s.action)).size).toBe(SHORTCUTS.length)
})

const act = (key: string, bindings: Parameters<typeof shortcutFor>[2], modifiers: { cmd?: boolean; shift?: boolean; ctrl?: boolean } = {}) =>
  shortcutFor({ key, modifiers }, context(), bindings)?.action

test('a moved key does its action, and the old letter is free', () => {
  const bindings = { scheme: 'single' as const, keys: { archive: 'y' } }
  expect(act('y', bindings)).toBe('archive')
  expect(act('e', bindings)).toBeUndefined()
  // Arrows keep their meaning when the letter beside them moves.
  expect(act('down', { scheme: 'single', keys: { next: 'n' } })).toBe('next')
  expect(act('j', { scheme: 'single', keys: { next: 'n' } })).toBeUndefined()
})

test('taking another action\'s key takes it from that action', () => {
  expect(act('r', { scheme: 'single', keys: { archive: 'r' } })).toBe('archive')
})

test('the ⌘ keyboard ignores single letters and answers to ⌘ combinations', () => {
  const bindings = { scheme: 'command' as const, keys: {} }
  expect(act('r', bindings)).toBeUndefined()
  expect(act('r', bindings, { cmd: true })).toBe('reply')
  expect(act('r', bindings, { cmd: true, shift: true })).toBe('replyAll')
  expect(act('a', bindings, { cmd: true, ctrl: true })).toBe('archive')
  expect(act('down', bindings)).toBe('next')
})

test('off means no mail shortcuts', () => {
  expect(act('e', { scheme: 'off', keys: {} })).toBeUndefined()
  expect(act('r', { scheme: 'off', keys: {} }, { cmd: true })).toBeUndefined()
})

test('the cheat sheet and hints show the keys in effect', () => {
  expect(shortcutList({ scheme: 'single', keys: { archive: 'y' } }).find((s) => s.action === 'archive')?.keys).toBe('Y')
  expect(shortcutList({ scheme: 'single', keys: { trash: 'x' } }).find((s) => s.action === 'trash')?.keys).toBe('X  ⌫')
  expect(hintFor('reply', { scheme: 'command', keys: {} })).toBe('⌘R')
  expect(shortcutList({ scheme: 'command', keys: {} }).some((s) => s.action === 'goInbox')).toBe(false)
})
