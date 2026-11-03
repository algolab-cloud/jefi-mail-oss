import type { FolderId, MailThread } from './data'
import { live } from './view'

// ---------------------------------------------------------------------------
// Every number the mail sidebar shows, from one pass over the account's conversations. The sidebar
// selects this from the store, so a publish that changes no count (most: a snippet, a read flag in
// another folder) doesn't re-render it, and the rows no longer each scan the list.
// ---------------------------------------------------------------------------

/** Read vs unread in a folder whose badge counts unread mail (screened mail left out). */
export type FolderStats = { all: number; unread: number; today: number; older: number; starred: number }

export type SidebarCounts = {
  /** Screened conversations waiting in the Inbox. */
  screened: number
  outbox: number
  drafts: number
  spamUnread: number
  /** For the folders the sidebar badges with unread mail (the Inbox). */
  stats: Partial<Record<FolderId, FolderStats>>
  /** Unread, by label id: what the label's view lists, so neither the trash nor spam (see threadInView). */
  labels: Record<string, number>
  /** Unread, by server folder path. */
  folders: Record<string, number>
}

export function sidebarCounts(threads: readonly MailThread[], statsFor: readonly FolderId[] = ['inbox']): SidebarCounts {
  const out: SidebarCounts = { screened: 0, outbox: 0, drafts: 0, spamUnread: 0, stats: {}, labels: {}, folders: {} }
  for (const id of statsFor) out.stats[id] = { all: 0, unread: 0, today: 0, older: 0, starred: 0 }
  for (const t of threads) {
    if (t.screened && t.folder === 'inbox') out.screened++
    if (t.folder === 'outbox') out.outbox++
    else if (t.folder === 'drafts') out.drafts++
    else if (t.folder === 'spam' && t.unread) out.spamUnread++
    const stats = t.screened ? undefined : out.stats[t.folder]
    if (stats) {
      stats.all++
      if (t.unread) {
        stats.unread++
        if (t.group === 'Today') stats.today++
        else if (t.group === 'Earlier') stats.older++
        if (t.starred) stats.starred++
      }
    }
    if (!t.unread) continue
    if (live(t)) for (const label of t.labels) out.labels[label] = (out.labels[label] ?? 0) + 1
    for (const path of t.folders ?? []) out.folders[path] = (out.folders[path] ?? 0) + 1
  }
  return out
}
