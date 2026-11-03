import type { MailThread } from './data'
import type { ViewCursor, ViewPage } from './engine/types'
import { threadInView, type MailboxView } from './view'

// ---------------------------------------------------------------------------
// The store's pages of the view on screen (lume-2vz). The engine hands out keyset pages (a cursor
// below the last conversation, one past the page for `hasMore`); these rules turn them into one list
// that only ever grows while someone is scrolled, and keep it current after a publish without
// fetching every page again: the first page is fetched fresh, and the deeper ones are patched with
// what the engine says changed since they were loaded.
// ---------------------------------------------------------------------------

export type ViewPages = {
  /** Conversation ids newest first, or null for a view the engine doesn't page (see viewPage). */
  order: string[] | null
  /** Below the last loaded page; null once the view's end is loaded. */
  cursor: ViewCursor | null
  hasMore: boolean
  loading: boolean
  /** The oldest list revision any loaded page reflects: changes since then are asked for. */
  revision: number
}

export const EMPTY_PAGES: ViewPages = { order: null, cursor: null, hasMore: false, loading: true, revision: 0 }

/** A view's first page, or a reload of everything it had (a reset). */
export function firstPages(result: ViewPage | null): ViewPages {
  if (!result) return { order: null, cursor: null, hasMore: false, loading: false, revision: 0 }
  return { order: result.threads.map((t) => t.id), cursor: result.nextCursor, hasMore: result.hasMore, loading: false, revision: result.revision }
}

/** The next page, appended below what's loaded. Ids already listed keep their place. */
export function appendPage(pages: ViewPages, result: ViewPage): ViewPages {
  const order = pages.order ?? []
  const listed = new Set(order)
  return {
    order: [...order, ...result.threads.map((t) => t.id).filter((id) => !listed.has(id))],
    cursor: result.nextCursor,
    hasMore: result.hasMore,
    loading: false,
    revision: Math.min(pages.revision, result.revision),
  }
}

/** Which of two cursors lies further down the list (null is the end of the view). */
const deeper = (a: ViewCursor | null, b: ViewCursor | null) => (!a || !b ? null : a.at < b.at || (a.at === b.at && a.key < b.key) ? a : b)

/**
 * A fresh first page (asked for with `since`) merged with the pages below it. New mail lands at the
 * top, the rest keeps its place, and the list doesn't shrink under someone who scrolled. Deeper
 * conversations the engine reports changed are refreshed (`upserts`; one that moved out of the view
 * drops out through threadInView), gone ones are dropped (`removed`). 'reset' means the engine
 * couldn't say what changed: reload `order.length` conversations in one go.
 */
export function refreshPages(
  pages: ViewPages,
  result: ViewPage,
  view: MailboxView,
  atOf: (id: string) => number | undefined,
): { pages: ViewPages; upserts: MailThread[]; removed: string[] } | 'reset' {
  const changes = result.changes
  if (changes === 'reset') return 'reset'
  const head = result.threads.map((t) => t.id)
  const removed = new Set(changes?.removed ?? [])
  const inHead = new Set(head)
  const order = [...head, ...(pages.order ?? []).filter((id) => !inHead.has(id) && !removed.has(id))]
  // The head may now reach past what was loaded (mail deleted above the old cursor).
  const cursor = deeper(pages.cursor, result.nextCursor)
  const hasMore = cursor === result.nextCursor ? result.hasMore : pages.hasMore
  const listed = new Set(order)
  const upserts: MailThread[] = []
  for (const thread of changes?.threads ?? []) {
    if (inHead.has(thread.id)) continue
    if (listed.has(thread.id)) {
      upserts.push(thread)
      continue
    }
    // New to this view within the loaded range (an old message filed here, say): slot it in by date.
    const at = thread.at ?? 0
    if (!threadInView(thread, view) || (cursor && at < cursor.at)) continue
    const index = order.findIndex((id, i) => i >= head.length && (atOf(id) ?? Infinity) < at)
    order.splice(index < 0 ? order.length : index, 0, thread.id)
    listed.add(thread.id)
    upserts.push(thread)
  }
  return { pages: { order, cursor, hasMore, loading: pages.loading, revision: result.revision }, upserts, removed: [...removed] }
}

/**
 * The rows a paged view shows: the loaded pages in the engine's order, with conversations the UI
 * knows about but the query couldn't have seen yet (just sent, just moved here) in front. The
 * account's window runs deeper than the first pages, so an unlisted conversation older than the
 * last loaded row isn't new: it's in a page not loaded yet and waits for it (lume-1if). Putting it in
 * front pushed every row on screen down by that many, then back up once its page arrived.
 */
export function pagedRows(threads: MailThread[], order: string[], hasMore: boolean, view: MailboxView): MailThread[] {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const paged = order.map((id) => byId.get(id)).filter((t): t is MailThread => !!t && threadInView(t, view))
  const listed = new Set(order)
  // Nothing below the loaded pages once the view's end is in.
  const floor = hasMore ? Math.min(...paged.map((t) => t.at ?? Infinity)) : -Infinity
  const front = threads.filter((t) => !listed.has(t.id) && threadInView(t, view) && (t.at ?? Infinity) >= floor)
  return [...front, ...paged]
}
