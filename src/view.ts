import type { FolderId, MailThread } from './data'

// ---------------------------------------------------------------------------
// Which conversation list is on screen, and what belongs in it. One rule, in one place: the UI
// filters the conversations it holds with `threadInView`, and the engine's view query (threads.ts,
// `loadView`) narrows the same set in SQL so its LIMIT counts this view's mail rather than the
// account's newest. A test pins the two together — view.test.ts.
// ---------------------------------------------------------------------------

/**
 * A built-in mailbox, the Screener, a Gmail label, a plain IMAP folder by path, or one of the views
 * across every account (All Inboxes, All Starred).
 */
export type MailboxView = FolderId | 'screener' | `label:${string}` | `folder:${string}` | UnifiedView

/** The views that list every account's mail together, newest first. */
export type UnifiedView = 'all:inbox' | 'all:starred'
export const UNIFIED_VIEWS: readonly UnifiedView[] = ['all:inbox', 'all:starred']
export const isUnified = (view: MailboxView): view is UnifiedView => view === 'all:inbox' || view === 'all:starred'
/** The one account's view a unified view is made of: what the engine pages, and what a row must match. */
export const baseView = (view: MailboxView): Exclude<MailboxView, UnifiedView> => (view === 'all:inbox' ? 'inbox' : view === 'all:starred' ? 'starred' : view)

/** The `label:`/`folder:` argument, when the view is one of those. */
export const labelOf = (view: MailboxView) => (view.startsWith('label:') ? view.slice('label:'.length) : null)
export const folderPathOf = (view: MailboxView) => (view.startsWith('folder:') ? view.slice('folder:'.length) : null)

/** Trash and Junk are the two mailboxes a conversation is only ever shown in on purpose. */
export const live = (thread: Pick<MailThread, 'folder'>) => thread.folder !== 'trash' && thread.folder !== 'spam'

/** Whether a conversation belongs in a view. */
export function threadInView(thread: MailThread, view: MailboxView): boolean {
  if (isUnified(view)) return threadInView(thread, baseView(view))
  if (view === 'starred') return thread.starred && live(thread)
  const label = labelOf(view)
  if (label !== null) return thread.labels.includes(label) && live(thread)
  if (view === 'screener') return !!thread.screened && thread.folder === 'inbox'
  const path = folderPathOf(view)
  if (path !== null) return !!thread.folders?.includes(path)
  // Mail only in custom folders has a placeholder `folder`, so it is in no built-in mailbox; mail
  // waiting in the Screener is out of the Inbox until its sender is allowed.
  return thread.folder === view && !thread.onlyInFolders && !(view === 'inbox' && !!thread.screened)
}
