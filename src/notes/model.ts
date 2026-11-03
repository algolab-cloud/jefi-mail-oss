import type { IconName } from '../icons'
import type { Link, LinkTarget, MailLinkTarget, Note } from '../engine'

// ---------------------------------------------------------------------------
// The notes view's pure parts: what a row and a link chip say, how times read, and the text an
// email becomes when it's added to a note. No React here, so all of it is tested directly.
// ---------------------------------------------------------------------------

/** The title a list row shows; an unnamed note reads by its first line instead. */
export function noteHeading(note: Pick<Note, 'title' | 'body'>): string {
  return note.title.trim() || firstLine(note.body) || 'New note'
}

/** The first line with words, markdown markers stripped (headings, quotes, bullets, emphasis). */
export function firstLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)+/, '')
      .replace(/[*_~`]+/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
    if (line) return line
  }
  return ''
}

/** A row's second line: the body's first line, unless the title already came from it. */
export function notePreview(note: Pick<Note, 'title' | 'body'>): string {
  if (note.title.trim()) return firstLine(note.body)
  const lines = note.body.split('\n').filter((l) => firstLine(l))
  return lines.length > 1 ? firstLine(lines.slice(1).join('\n')) : ''
}

/**
 * Pinned first, then latest edited. The engine already answers in this order (and by relevance when
 * searching); this keeps a list the UI patched optimistically in the same shape.
 */
export function orderNotes<T extends Pick<Note, 'pinned' | 'updatedAt'>>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

/** What the search box sends the engine: nothing for blank input, so the full list comes back. */
export const searchQuery = (input: string) => input.trim().replace(/\s+/g, ' ')

const DAY = 86_400_000
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)

/** "3:42 PM" today, "Yesterday", a weekday this week, "Sep 12" this year, else "Sep 12, 2025". */
export function formatWhen(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  const date = new Date(ms)
  if (days <= 0) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'long' })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The list's heading for a note last edited at `ms`: Today, Yesterday, Previous 7 days and so on. */
export function noteGroup(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Previous 7 days'
  if (days < 30) return 'Previous 30 days'
  return 'Earlier'
}

/** A row's time under its heading: the time of day under Today and Yesterday (the heading has the day). */
export function rowTime(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  return days === 1 ? new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : formatWhen(ms, now)
}

// --- Checklists and the read view ------------------------------------------------------

/** "- [ ] Call Lea", "  * [x] Done": a checklist item, with its indent and text. */
const TASK_LINE = /^(\s*)[-*+]\s+\[([ xX])\](?:\s+(.*))?$/
const FENCE = /^\s*(```|~~~)/

/** A note's body as the read view draws it: Markdown runs between checklist items it can tick. */
export type NoteBlock = { kind: 'text'; source: string } | { kind: 'task'; line: number; done: boolean; text: string; indent: number }

/** Checklist items (outside code blocks) with their line numbers, and the text between them. */
export function noteBlocks(body: string): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let text: string[] = []
  let fenced = false
  const flush = () => {
    const source = text.join('\n').replace(/^\s*\n|\n\s*$/g, '')
    if (source.trim()) blocks.push({ kind: 'text', source })
    text = []
  }
  body.split('\n').forEach((raw, line) => {
    if (FENCE.test(raw)) fenced = !fenced
    const task = fenced ? null : TASK_LINE.exec(raw)
    if (!task) return void text.push(raw)
    flush()
    blocks.push({ kind: 'task', line, done: task[2] !== ' ', text: task[3] ?? '', indent: Math.floor(task[1]!.replace(/\t/g, '  ').length / 2) })
  })
  flush()
  return blocks
}

/** The body with the checklist item on `line` ticked or unticked; unchanged if it isn't one. */
export function toggleTask(body: string, line: number): string {
  const lines = body.split('\n')
  const raw = lines[line]
  if (raw === undefined || !TASK_LINE.test(raw)) return body
  lines[line] = raw.replace(/\[([ xX])\]/, (_, mark: string) => (mark === ' ' ? '[x]' : '[ ]'))
  return lines.join('\n')
}

/** How much of a note's checklist is done, for its list row; null when it has none. */
export function checklistProgress(body: string): { done: number; total: number } | null {
  const tasks = noteBlocks(body).filter((b): b is Extract<NoteBlock, { kind: 'task' }> => b.kind === 'task')
  return tasks.length ? { done: tasks.filter((t) => t.done).length, total: tasks.length } : null
}

/** Words in the body, Markdown markers aside: "124 words" in the editor's footer. */
export function wordCount(body: string): number {
  return body.replace(/[#>*_~`|[\]()]+/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/** An event start: "Tue, Sep 29 · 2:00 PM", or just the day when it's all-day (UTC midnight). */
export function formatEventStart(ms: number): string {
  const d = new Date(ms)
  const allDay = d.getUTCHours() === 0 && d.getUTCMinutes() === 0
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(allDay ? { timeZone: 'UTC' } : {}) })
  return allDay ? day : `${day} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

/** A mail link whose account was removed: nothing left to point at. */
export const isDetached = (target: Link['target']) => 'accountId' in target && target.accountId === null

/** A live link opens; a gone one shows its snapshot only; a detached one lost its account. */
export type LinkState = 'live' | 'gone' | 'detached'

export type LinkView = {
  icon: IconName
  /** Who or what: the sender, the event's title, the contact. */
  primary: string
  /** The subject, the event's time, the contact's address. */
  secondary: string
  /** A short date for the trailing edge, when there is one. */
  when: string
  state: LinkState
  /** Why it can't open, for the muted style's tooltip and label. */
  note?: string
}

/** How a note's link reads, from its snapshot, so it still makes sense once its target is gone. */
export function linkView(link: Pick<Link, 'target' | 'snapshot' | 'live'>, now = Date.now()): LinkView {
  const { target, snapshot } = link
  const state: LinkState = isDetached(target) ? 'detached' : link.live ? 'live' : 'gone'
  if (target.kind === 'event') {
    return {
      icon: 'calendar',
      primary: snapshot.title || 'Event',
      secondary: snapshot.date ? formatEventStart(snapshot.date) : '',
      when: '',
      state,
      note: state === 'live' ? undefined : 'This event was deleted',
    }
  }
  if (target.kind === 'contact') {
    const email = snapshot.email ?? ('email' in target ? target.email : '')
    return { icon: 'user', primary: snapshot.name || email, secondary: snapshot.name ? email : '', when: '', state }
  }
  return {
    icon: 'mail',
    primary: snapshot.from?.name || snapshot.from?.email || 'Email',
    secondary: snapshot.subject || '(no subject)',
    when: snapshot.date ? formatWhen(snapshot.date, now) : '',
    state,
    note: state === 'live' ? undefined : state === 'detached' ? 'Its account was removed' : 'No longer in your mailbox',
  }
}

/** Links that still open first, oldest first; gone ones after them. */
export const liveFirst = <T extends Pick<Link, 'live' | 'createdAt'>>(links: readonly T[]): T[] =>
  [...links].sort((a, b) => Number(b.live) - Number(a.live) || a.createdAt - b.createdAt)

/** The conversation a UI message id belongs to: Message.id is `${threadId}-${rowid}`. */
export const threadOfMessage = (messageId: string) => messageId.slice(0, messageId.lastIndexOf('-'))

/** Where a live mail link opens: its account and conversation. */
export function mailDestination(target: Link['target']): { accountId: string; threadId: string } | null {
  if (!('accountId' in target) || target.accountId === null) return null
  if ('threadId' in target) return { accountId: target.accountId, threadId: target.threadId }
  if ('messageId' in target) return { accountId: target.accountId, threadId: threadOfMessage(target.messageId) }
  return null
}

/** The targets a deleted note's (or task's) links can be restored from; detached ones have nothing to point at. */
export const restorableTargets = (note: { links: readonly Pick<Link, 'target'>[] }): LinkTarget[] =>
  note.links.flatMap((link) => (isDetached(link.target) ? [] : [link.target as LinkTarget]))

// --- Adding an email to a note --------------------------------------------------

export type EmailSource = { accountId: string; threadId: string; messageId?: string; excerpt?: string }

export const emailTarget = (source: EmailSource): MailLinkTarget =>
  source.messageId
    ? { kind: 'message', accountId: source.accountId, messageId: source.messageId }
    : { kind: 'thread', accountId: source.accountId, threadId: source.threadId }

/** The excerpt as a markdown quote, attributed to its sender; blank lines stay inside the quote. */
export function quoteEmail(excerpt: string | undefined, snapshot: Link['snapshot']): string {
  const who = snapshot.from?.name || snapshot.from?.email
  const when = snapshot.date ? new Date(snapshot.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
  const credit = [who, when].filter(Boolean).join(', ')
  const text = excerpt?.trim()
  if (!text) return credit ? `From ${credit}: “${snapshot.subject || '(no subject)'}”` : ''
  const quoted = text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
    .join('\n')
  return credit ? `${quoted}\n>\n> — ${credit}` : quoted
}

/** A note body with another block added after what's there, separated by one blank line. */
export function appendBlock(body: string, block: string): string {
  if (!block) return body
  const head = body.trimEnd()
  return head ? `${head}\n\n${block}\n` : `${block}\n`
}
