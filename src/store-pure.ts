// The store's pure helpers, apart from the store itself: tests that stand in for the store (see
// compose.test.tsx) spread these in, so the real ones reach every module that imports them.
import type { FolderId, Label } from './data'
import type { MailRule } from './engine/rules'

export const FOLDER_NAMES: Record<FolderId, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  snoozed: 'Snoozed',
  outbox: 'Outbox',
  sent: 'Sent',
  drafts: 'Drafts',
  archive: 'Archive',
  spam: 'Spam',
  trash: 'Trash',
}

/**
 * The toast for local changes the engine gave up on and undid ('changesDropped'), e.g. "Couldn't
 * archive 3 messages — restored".
 */
export function droppedChangeMessage(change: { kind: 'flags' | 'move' | 'delete' | 'labels'; folder?: FolderId; count: number }): string {
  const n = change.count === 1 ? '1 message' : `${change.count.toLocaleString()} messages`
  const what =
    change.kind === 'delete'
      ? `delete ${n}`
      : change.kind === 'flags'
        ? `update ${n}`
        : change.kind === 'labels'
          ? `change the labels of ${n}`
          : change.folder === 'archive'
            ? `archive ${n}`
            : change.folder
              ? `move ${n} to ${FOLDER_NAMES[change.folder]}`
              : `move ${n}`
  return `Couldn't ${what} — restored`
}

/** The editor's rule for a draft: a new one (from scratch or a context menu) or an existing rule to edit. */
export function ruleDraftFrom(draft: Partial<MailRule>, now = Date.now()): MailRule {
  return {
    id: draft.id ?? `rule-${now.toString(36)}`,
    name: draft.name ?? 'New rule',
    enabled: draft.enabled ?? true,
    match: draft.match ?? {},
    actions: draft.actions ?? { moveTo: 'archive' },
  }
}

/** Jefi's labels and the server's, each id once: the server's copy wins once it knows the label. */
export function mergeLabels(local: readonly Label[], server: readonly Label[]): Label[] {
  const known = new Set(server.map((l) => l.id))
  return [...local.filter((l) => !known.has(l.id)), ...server]
}

/** When a snooze option ends: mornings at 8:00, "later today" three hours out. */
export function snoozeTime(option: string, now = new Date()): number {
  const at = (days: number, hour = 8) => {
    const d = new Date(now)
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }
  if (option === 'Later today') return now.getTime() + 3 * 3_600_000
  if (option === 'Tomorrow') return at(1)
  if (option === 'This weekend') return at(((6 - now.getDay() + 7) % 7) || 7)
  if (option === 'Next week') return at(((1 - now.getDay() + 7) % 7) || 7)
  return at(1)
}
