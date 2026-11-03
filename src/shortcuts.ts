import type { KeyPress } from './keys'

// ---------------------------------------------------------------------------
// The conventional mail keyboard: one key per action, plus `g` then a letter for the mailboxes.
// Pure on purpose — a key press and what the window is doing go in, an action comes out — so the
// mapping, the two-key state machine and the "they're typing" guard can be tested on their own.
// ---------------------------------------------------------------------------

export type ShortcutAction =
  | 'next'
  | 'previous'
  | 'open'
  | 'archive'
  | 'trash'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'compose'
  | 'star'
  | 'unread'
  | 'makeTask'
  | 'search'
  | 'help'
  | 'goInbox'
  | 'goStarred'
  | 'goDrafts'
  | 'goSent'
  | 'newNote'
  | 'searchNotes'

/** How long `g` waits for the letter that follows it. */
export const PREFIX_TIMEOUT_MS = 1000

/** A `g` waiting for its second key, and when it was pressed. */
export type Prefix = { key: 'g'; at: number } | null

export type ShortcutContext = {
  /** A text field has keyboard focus: the key is being typed, not commanded. */
  typing: boolean
  /** Something else owns the keyboard: the palette, a menu, compose, Settings, the cheat sheet. */
  busy: boolean
  prefix: Prefix
  now: number
}

/**
 * `null` means the key means nothing here, so whoever else wants it still gets it. Otherwise the
 * result carries the prefix state to keep, and an `action` when one fired — a result without an
 * action (the `g` of `g i`) has still done its work but does not consume the key.
 */
export type ShortcutResult = { action?: ShortcutAction; prefix: Prefix }

/** One key, one action. Both the letter and the arrow where mail clients offer both. */
const SINGLE: Record<string, ShortcutAction> = {
  j: 'next',
  down: 'next',
  k: 'previous',
  up: 'previous',
  enter: 'open',
  return: 'open',
  e: 'archive',
  '#': 'trash',
  backspace: 'trash',
  delete: 'trash',
  r: 'reply',
  a: 'replyAll',
  f: 'forward',
  c: 'compose',
  s: 'star',
  u: 'unread',
  t: 'makeTask',
  '/': 'search',
  '?': 'help',
}

/** The letter after `g`. */
const AFTER_G: Record<string, ShortcutAction> = { i: 'goInbox', s: 'goStarred', d: 'goDrafts', t: 'goSent' }

/**
 * Which keyboard a person uses: single letters (Gmail's), ⌘ combinations (Apple Mail's, for people
 * who'd rather a stray key did nothing), or no mail shortcuts at all. `keys` holds single-key actions
 * they moved to a key of their own.
 */
export type ShortcutScheme = 'single' | 'command' | 'off'
export type ShortcutBindings = { scheme: ShortcutScheme; keys: Partial<Record<ShortcutAction, string>> }
export const DEFAULT_BINDINGS: ShortcutBindings = { scheme: 'single', keys: {} }

/** Keys that keep their meaning whatever is rebound: arrows and Enter aren't letters to reassign. */
const FIXED_KEYS = new Set(['down', 'up', 'enter', 'return', 'backspace', 'delete'])

/** The ⌘ keyboard, as "modifiers+key" (cmd, shift, ctrl in that order). Arrows and Enter as before. */
const COMMAND: Record<string, ShortcutAction> = {
  down: 'next',
  up: 'previous',
  enter: 'open',
  return: 'open',
  'cmd+backspace': 'trash',
  'cmd+delete': 'trash',
  'cmd+ctrl+a': 'archive',
  'cmd+r': 'reply',
  'cmd+shift+r': 'replyAll',
  'cmd+shift+f': 'forward',
  'cmd+shift+l': 'star',
  'cmd+shift+u': 'unread',
  'cmd+shift+t': 'makeTask',
  'cmd+ctrl+f': 'search',
  'cmd+/': 'help',
}

/** The single-key map with the person's own keys in it: a moved action leaves its old letter free. */
export function singleKeys(keys: ShortcutBindings['keys']): Record<string, ShortcutAction> {
  const map: Record<string, ShortcutAction> = { ...SINGLE }
  for (const [action, key] of Object.entries(keys) as Array<[ShortcutAction, string]>) {
    if (!key) continue
    for (const [existing, bound] of Object.entries(map)) if (bound === action && !FIXED_KEYS.has(existing)) delete map[existing]
    map[key.toLowerCase()] = action
  }
  return map
}

/** Actions that have a single key to move; the `g` jumps and the notes keys stay where they are. */
export const REBINDABLE: readonly ShortcutAction[] = ['next', 'previous', 'archive', 'trash', 'star', 'unread', 'makeTask', 'reply', 'replyAll', 'forward', 'compose', 'search', 'help']

/** Whether a key can be a shortcut of its own: one printable character that isn't `g` (the prefix). */
export const assignableKey = (key: string) => key.length === 1 && key !== 'g' && key !== ' '

/**
 * What a key press means. GPUI reports the unshifted key on some layouts, so `?` also arrives as
 * shift-`/` and `#` as shift-3.
 */
export function shortcutFor(press: KeyPress, context: ShortcutContext, bindings: ShortcutBindings = DEFAULT_BINDINGS): ShortcutResult | null {
  const modifiers = press.modifiers ?? {}
  if (bindings.scheme === 'off') return null
  if (context.typing || context.busy) return null
  const pressed = press.key?.toLowerCase()
  if (!pressed) return null
  if (bindings.scheme === 'command') {
    if (modifiers.alt) return null
    const combo = [modifiers.cmd && 'cmd', modifiers.shift && 'shift', modifiers.ctrl && 'ctrl', pressed].filter(Boolean).join('+')
    const action = COMMAND[combo]
    return action ? { action, prefix: null } : null
  }
  // Anything with a command key is a menu shortcut (⌘N, ⌘K), not one of these.
  if (modifiers.cmd || modifiers.ctrl || modifiers.alt) return null
  const key = modifiers.shift ? ({ '/': '?', '3': '#' }[pressed] ?? pressed) : pressed

  // A stale `g` has expired: treat this as a fresh press.
  const waiting = context.prefix && context.now - context.prefix.at <= PREFIX_TIMEOUT_MS ? context.prefix : null
  if (waiting) {
    const jump = AFTER_G[key]
    // Anything else cancels the `g` and counts on its own, so `g` then `j` still moves down.
    if (jump) return { action: jump, prefix: null }
  }
  if (key === 'g') return { prefix: { key: 'g', at: context.now } }
  const action = (bindings.keys && Object.keys(bindings.keys).length ? singleKeys(bindings.keys) : SINGLE)[key]
  if (!action) return waiting ? { prefix: null } : null
  return { action, prefix: null }
}

/** Every shortcut, in cheat-sheet order. Also where the command palette's hints come from. */
export const SHORTCUTS: ReadonlyArray<{ action: ShortcutAction; keys: string; label: string; group: string }> = [
  { action: 'next', keys: 'J  ↓', label: 'Next conversation', group: 'Moving around' },
  { action: 'previous', keys: 'K  ↑', label: 'Previous conversation', group: 'Moving around' },
  { action: 'open', keys: 'Enter', label: 'Open', group: 'Moving around' },
  { action: 'search', keys: '/', label: 'Search mail', group: 'Moving around' },
  { action: 'help', keys: '?', label: 'Keyboard shortcuts', group: 'Moving around' },
  { action: 'archive', keys: 'E', label: 'Archive', group: 'This conversation' },
  { action: 'trash', keys: '#  ⌫', label: 'Move to Trash', group: 'This conversation' },
  { action: 'star', keys: 'S', label: 'Star', group: 'This conversation' },
  { action: 'unread', keys: 'U', label: 'Mark unread or read', group: 'This conversation' },
  { action: 'makeTask', keys: 'T', label: 'Make a task', group: 'This conversation' },
  { action: 'reply', keys: 'R', label: 'Reply', group: 'Writing' },
  { action: 'replyAll', keys: 'A', label: 'Reply all', group: 'Writing' },
  { action: 'forward', keys: 'F', label: 'Forward', group: 'Writing' },
  { action: 'compose', keys: 'C  ⌘N', label: 'New message', group: 'Writing' },
  { action: 'goInbox', keys: 'G I', label: 'Go to Inbox', group: 'Mailboxes' },
  { action: 'goStarred', keys: 'G S', label: 'Go to Starred', group: 'Mailboxes' },
  { action: 'goDrafts', keys: 'G D', label: 'Go to Drafts', group: 'Mailboxes' },
  { action: 'goSent', keys: 'G T', label: 'Go to Sent', group: 'Mailboxes' },
  { action: 'newNote', keys: 'N', label: 'New note', group: 'Notes' },
  { action: 'searchNotes', keys: '⌘F', label: 'Search notes', group: 'Notes' },
]

/** How the ⌘ keyboard writes each action's keys. */
const COMMAND_KEYS: Partial<Record<ShortcutAction, string>> = {
  next: '↓',
  previous: '↑',
  open: 'Enter',
  search: '⌃⌘F',
  help: '⌘/',
  archive: '⌃⌘A',
  trash: '⌘⌫',
  star: '⇧⌘L',
  unread: '⇧⌘U',
  makeTask: '⇧⌘T',
  reply: '⌘R',
  replyAll: '⇧⌘R',
  forward: '⇧⌘F',
  compose: '⌘N',
}

/** The shortcuts as they are for these bindings, in cheat-sheet order; actions with no key are left out. */
export function shortcutList(bindings: ShortcutBindings = DEFAULT_BINDINGS) {
  if (bindings.scheme === 'off') return SHORTCUTS.filter((s) => s.action === 'compose' || s.group === 'Notes').map((s) => (s.action === 'compose' ? { ...s, keys: '⌘N' } : s))
  if (bindings.scheme === 'command') return SHORTCUTS.flatMap((s) => (COMMAND_KEYS[s.action] ? [{ ...s, keys: COMMAND_KEYS[s.action]! }] : s.group === 'Notes' ? [s] : []))
  return SHORTCUTS.map((s) => {
    const own = bindings.keys[s.action]
    if (!own) return s
    // The person's key, plus an arrow or ⌫ the action also had.
    const fixed = s.keys.split(/\s{2,}/).filter((k) => /^[↓↑⌫]$|^⌘N$|^Enter$/.test(k))
    return { ...s, keys: [own.toUpperCase(), ...fixed].join('  ') }
  })
}

/** The keys for an action, for a command palette hint. */
export const hintFor = (action: ShortcutAction, bindings: ShortcutBindings = DEFAULT_BINDINGS) => shortcutList(bindings).find((s) => s.action === action)?.keys

/**
 * The notes view's own keys, which only mean something while it's open: `n` starts a note (unless
 * they're typing), ⌘F searches, Esc steps back.
 */
export function notesKeyFor(press: KeyPress, context: { typing: boolean }): 'newNote' | 'search' | 'escape' | null {
  const modifiers = press.modifiers ?? {}
  const key = press.key?.toLowerCase()
  if (key === 'escape') return 'escape'
  if ((modifiers.cmd || modifiers.ctrl) && !modifiers.alt && !modifiers.shift && key === 'f') return 'search'
  if (key === 'n' && !modifiers.cmd && !modifiers.ctrl && !modifiers.alt && !modifiers.shift && !context.typing) return 'newNote'
  return null
}
