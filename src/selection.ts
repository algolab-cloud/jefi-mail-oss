import type { MailThread } from './data'

// ---------------------------------------------------------------------------
// Which conversation the reader shows when the open one leaves the list (archived, deleted, moved,
// snoozed, or changed on another device): the one that took its place, like Mail and Superhuman,
// rather than whatever happens to be at the top of the list.
// ---------------------------------------------------------------------------

/**
 * The conversation to show in place of `active`, which was in `before` (the list's ids a moment
 * ago, in order) and is no longer in `now`: the nearest one below it that is still listed, else the
 * nearest above. Drafts open the composer rather than the reader, so they are passed over. Null
 * when `active` is still listed, or wasn't in the list before either.
 */
export function successor(before: readonly string[], now: readonly MailThread[], active: string | null): MailThread | null {
  if (!active || now.some((t) => t.id === active)) return null
  const at = before.indexOf(active)
  if (at < 0) return null
  const listed = new Map(now.filter((t) => t.folder !== 'drafts').map((t) => [t.id, t]))
  for (let i = at + 1; i < before.length; i++) {
    const next = listed.get(before[i]!)
    if (next) return next
  }
  for (let i = at - 1; i >= 0; i--) {
    const previous = listed.get(before[i]!)
    if (previous) return previous
  }
  return null
}

/**
 * The conversation the reader shows when none was clicked: the one it was already showing that way
 * (`shown`), while it's still listed, so new mail arriving above it doesn't swap it (and a reply
 * being typed) out; otherwise the first conversation that isn't a draft.
 */
export function unclickedThread(now: readonly MailThread[], shown: string | null): MailThread | undefined {
  return (shown ? now.find((t) => t.id === shown) : undefined) ?? now.find((t) => t.folder !== 'drafts')
}
