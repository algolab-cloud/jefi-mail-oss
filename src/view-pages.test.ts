import { expect, test } from 'bun:test'
import type { MailThread } from './data'
import type { ViewPage } from './engine/types'
import { appendPage, firstPages, pagedRows, refreshPages } from './view-pages'

// ---------------------------------------------------------------------------
// The store's side of keyset paging: pages append, and a refresh after a publish keeps what was
// scrolled into while new mail lands on top and moved or deleted conversations drop out.
// ---------------------------------------------------------------------------

const thread = (n: number, change: Partial<MailThread> = {}): MailThread =>
  ({ id: `a:${n}`, at: 1000 - n, folder: 'inbox', subject: `T${n}`, messages: [], labels: [], ...change }) as MailThread
const result = (threads: MailThread[], more: boolean, extra: Partial<ViewPage> = {}): ViewPage => ({
  threads,
  hasMore: more,
  nextCursor: more ? { at: threads.at(-1)!.at!, key: threads.at(-1)!.id.slice(2) } : null,
  revision: 1,
  ...extra,
})
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => thread(from + i))
const atOf = (id: string) => 1000 - Number(id.slice(2))

test('pages append in order and never repeat an id', () => {
  const first = firstPages(result(range(1, 3), true))
  const next = appendPage(first, result([thread(3), ...range(4, 5)], false, { revision: 4 }))
  expect(next.order).toEqual(['a:1', 'a:2', 'a:3', 'a:4', 'a:5'])
  expect(next.hasMore).toBe(false)
  // The older revision wins: changes since then are what the first page hasn't seen.
  expect(next.revision).toBe(1)
})

test('a refresh puts new mail on top and keeps the pages below it, however deep', () => {
  const loaded = appendPage(firstPages(result(range(1, 3), true)), result(range(4, 6), true))
  const head = result([thread(0), ...range(1, 2)], true, { revision: 7, changes: { threads: [thread(0)], removed: [] } })
  const merged = refreshPages(loaded, head, 'inbox', atOf)
  if (merged === 'reset') throw new Error('unexpected reset')
  expect(merged.pages.order).toEqual(['a:0', 'a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6'])
  // Still continues where the deepest page ended, not below the fresh head.
  expect(merged.pages.cursor).toEqual(loaded.cursor)
  expect(merged.pages.hasMore).toBe(true)
  expect(merged.pages.revision).toBe(7)
})

test('deeper conversations that changed are refreshed, and deleted ones dropped', () => {
  const loaded = appendPage(firstPages(result(range(1, 3), true)), result(range(4, 6), true))
  const moved = thread(5, { folder: 'archive' })
  const head = result(range(1, 3), true, { changes: { threads: [moved], removed: ['a:4'] } })
  const merged = refreshPages(loaded, head, 'inbox', atOf)
  if (merged === 'reset') throw new Error('unexpected reset')
  // The moved one keeps its place; the list filters it out by its new folder (threadInView).
  expect(merged.pages.order).toEqual(['a:1', 'a:2', 'a:3', 'a:5', 'a:6'])
  expect(merged.upserts).toEqual([moved])
  expect(merged.removed).toEqual(['a:4'])
})

test('mail new to the view inside the loaded range is slotted in by date; below it waits for its page', () => {
  const loaded = appendPage(firstPages(result(range(1, 2), true)), result(range(4, 6), true))
  const filed = thread(3)
  const older = thread(9)
  const head = result(range(1, 2), true, { changes: { threads: [filed, older], removed: [] } })
  const merged = refreshPages(loaded, head, 'inbox', atOf)
  if (merged === 'reset') throw new Error('unexpected reset')
  expect(merged.pages.order).toEqual(['a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6'])
  expect(merged.upserts).toEqual([filed])
})

test('a refresh the engine cannot patch asks for a reload', () => {
  const loaded = firstPages(result(range(1, 3), true))
  expect(refreshPages(loaded, result(range(1, 3), true, { changes: 'reset' }), 'inbox', atOf)).toBe('reset')
})

test('a view loaded to its end stays complete when new mail pushes the head down', () => {
  const loaded = firstPages(result(range(1, 3), false))
  const merged = refreshPages(loaded, result([thread(0), ...range(1, 2)], true, { changes: { threads: [thread(0)], removed: [] } }), 'inbox', atOf)
  if (merged === 'reset') throw new Error('unexpected reset')
  expect(merged.pages.order).toEqual(['a:0', 'a:1', 'a:2', 'a:3'])
  expect(merged.pages.hasMore).toBe(false)
  expect(merged.pages.cursor).toBeNull()
})

test('account-window rows below the loaded pages wait for their page instead of jumping in front (lume-1if)', () => {
  // The account window holds 1-5; pages have loaded 1-3 so far. 9 is just sent, so the query hasn't seen it.
  const sent = thread(9, { at: 2000 })
  const window = [sent, ...range(1, 5)]
  const ids = (rows: MailThread[]) => rows.map((t) => t.id)
  expect(ids(pagedRows(window, ['a:1', 'a:2', 'a:3'], true, 'inbox'))).toEqual(['a:9', 'a:1', 'a:2', 'a:3'])
  // The next page arrives: rows already shown keep their place, the new ones go below.
  expect(ids(pagedRows(window, ['a:1', 'a:2', 'a:3', 'a:4', 'a:5'], false, 'inbox'))).toEqual(['a:9', 'a:1', 'a:2', 'a:3', 'a:4', 'a:5'])
  // At the view's end nothing is below the pages, so an unlisted row is always shown.
  expect(ids(pagedRows([thread(7)], [], false, 'inbox'))).toEqual(['a:7'])
})
