import { describe, expect, test } from 'bun:test'
import type { MailThread } from './data'
import { deepEqual, keepLoadedBodies, reuseUnchanged, reuseUnchangedItems, sameItems, shallowEqual } from './store-equality'

const thread = (id: string, change: Partial<MailThread> = {}) =>
  ({ id, subject: `Subject ${id}`, labels: ['a'], messages: [{ id: `${id}-1`, body: '' }], unread: false, ...change }) as unknown as MailThread

describe('shallowEqual', () => {
  test('compares own keys by identity', () => {
    const labels = ['a']
    expect(shallowEqual({ a: 1, labels }, { a: 1, labels })).toBe(true)
    expect(shallowEqual({ a: 1, labels }, { a: 1, labels: ['a'] })).toBe(false)
    expect(shallowEqual([1, 2], [1, 2])).toBe(true)
    expect(shallowEqual([1], { 0: 1 })).toBe(false)
    expect(shallowEqual({ a: undefined }, { b: undefined })).toBe(false)
  })
})

describe('deepEqual', () => {
  test('compares nested plain data', () => {
    expect(deepEqual(thread('1'), thread('1'))).toBe(true)
    expect(deepEqual(thread('1'), thread('1', { unread: true }))).toBe(false)
    expect(deepEqual(thread('1'), thread('1', { labels: ['a', 'b'] }))).toBe(false)
  })
})

describe('deepEqual and undefined', () => {
  test('a key holding undefined is the same as no key, as in JSON', () => {
    expect(deepEqual({ a: 1, draft: undefined }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, draft: undefined })).toBe(true)
    expect(deepEqual({ a: 1, draft: undefined }, { a: 1, draft: null })).toBe(false)
    expect(deepEqual({ a: undefined }, { b: 1 })).toBe(false)
    expect(deepEqual([undefined], [])).toBe(false)
  })
})

describe('sameItems', () => {
  test('the same items in the same order, by identity', () => {
    const a = thread('1')
    const b = thread('2')
    expect(sameItems([a, b], [a, b])).toBe(true)
    expect(sameItems([a, b], [b, a])).toBe(false)
    expect(sameItems([a], [thread('1')])).toBe(false)
    expect(sameItems([a], [a, b])).toBe(false)
  })
})

describe('keepLoadedBodies', () => {
  const opened = (id: string) => ({ ...thread(id), full: true, draft: undefined, messages: [{ id: `${id}-1`, body: 'loaded body' }] }) as unknown as MailThread
  test('an opened conversation republished unchanged is handed back as it was', () => {
    const before = [opened('1'), thread('2')]
    const next = reuseUnchanged(keepLoadedBodies([thread('1'), thread('2')], before), before)
    expect(next[0]).toBe(before[0]!)
    expect(next[1]).toBe(before[1]!)
  })
  test('a message whose send state changed is a new object with the body kept', () => {
    const before = [opened('1')]
    const [next] = keepLoadedBodies([thread('1', { messages: [{ id: '1-1', body: '', status: 'failed' }] } as never)], before)
    expect(next!.messages[0]).toMatchObject({ body: 'loaded body', status: 'failed' })
    expect(next!.full).toBe(true)
  })
})

describe('reuseUnchanged', () => {
  test('keeps the object on screen for unchanged conversations and takes the new one otherwise', () => {
    const before = [thread('1'), thread('2')]
    const next = reuseUnchanged([thread('1'), thread('2', { unread: true }), thread('3')], before)
    expect(next[0]).toBe(before[0]!)
    expect(next[1]).not.toBe(before[1]!)
    expect(next[1]!.unread).toBe(true)
    expect(next[2]!.id).toBe('3')
  })
})

describe('reuseUnchangedItems', () => {
  const task = (id: string, title: string, labels: string[] = []) => ({ id, title, labels: labels.map((name) => ({ id: name, name })) })
  test('a refetch keeps the items that did not change, and the list when none did', () => {
    const before = [task('a', 'A', ['bug']), task('b', 'B')]
    const same = [task('a', 'A', ['bug']), task('b', 'B')]
    expect(reuseUnchangedItems(before, same)).toBe(before)
    const edited = [task('a', 'A', ['bug']), task('b', 'B2')]
    const out = reuseUnchangedItems(before, edited)
    expect(out).not.toBe(before)
    expect(out[0]).toBe(before[0])
    expect(out[1]).toBe(edited[1])
    // A label renamed deep inside an item is a change.
    expect(reuseUnchangedItems(before, [task('a', 'A', ['bugs']), task('b', 'B')])[0]).not.toBe(before[0])
    // Reordered, removed, or added: same items kept, new list.
    const reordered = reuseUnchangedItems(before, [task('b', 'B'), task('a', 'A', ['bug'])])
    expect(reordered).not.toBe(before)
    expect(reordered[0]).toBe(before[1])
    expect(reuseUnchangedItems(before, [task('a', 'A', ['bug'])])).toEqual([before[0]])
  })
  test('occurrences match by key (a recurring event repeats its id); non-lists by deep equality', () => {
    const occ = (key: string, start: number) => ({ id: 'e1', key, start })
    const before = [occ('e1@1', 1), occ('e1@2', 2)]
    expect(reuseUnchangedItems(before, [occ('e1@1', 1), occ('e1@2', 2)])).toBe(before)
    expect(reuseUnchangedItems(before, [occ('e1@2', 2), occ('e1@1', 1)])[0]).toBe(before[1])
    const note = { id: 'n', title: 'x' }
    expect(reuseUnchangedItems(note, { id: 'n', title: 'x' })).toBe(note)
    expect(reuseUnchangedItems(null, [1])).toEqual([1])
  })
})
