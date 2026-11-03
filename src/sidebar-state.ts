import type { KeyPress } from './keys'
import type { FolderId } from './data'
import { FRESH_MS, type SyncView } from './sync-view'
import type { UpdateState } from './updater'

// ---------------------------------------------------------------------------
// The sidebar's pure pieces: which app is showing, what the rail badges say, and which of the mail
// column's sections are open. Kept apart from the components so they can be tested on their own.
// ---------------------------------------------------------------------------

/** The apps in the rail. Clean up, Rules and Settings belong to Mail. */
export type AppName = 'mail' | 'calendar' | 'notes' | 'tasks'
export type Tool = 'cleanup' | 'rules' | 'notes' | 'calendar' | 'tasks'

export const appOf = (tool: Tool | null): AppName => (tool === 'calendar' || tool === 'notes' || tool === 'tasks' ? tool : 'mail')

/** The collapsible parts of the mail column. */
export type SidebarSection = 'more' | 'labels' | 'folders'

export type SidebarPrefs = {
  /** The context column is hidden; the rail stays. */
  collapsed: boolean
  open: Record<SidebarSection, boolean>
}

export const DEFAULT_SIDEBAR: SidebarPrefs = { collapsed: false, open: { more: false, labels: true, folders: true } }

/** Settings files from before the rail, or edited by hand, fall back to the defaults key by key. */
export function normalizeSidebar(raw: unknown): SidebarPrefs {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { collapsed?: unknown; open?: Record<string, unknown> }
  const open = value.open && typeof value.open === 'object' ? value.open : {}
  const flag = (key: SidebarSection) => (typeof open[key] === 'boolean' ? (open[key] as boolean) : DEFAULT_SIDEBAR.open[key])
  return { collapsed: value.collapsed === true, open: { more: flag('more'), labels: flag('labels'), folders: flag('folders') } }
}

export const toggleSection = (prefs: SidebarPrefs, section: SidebarSection): SidebarPrefs => ({ ...prefs, open: { ...prefs.open, [section]: !prefs.open[section] } })

/** Mailboxes that stay in view; the rest fold under More. */
export const CORE_FOLDERS: readonly FolderId[] = ['inbox', 'starred', 'snoozed', 'outbox', 'sent', 'drafts']
export const MORE_FOLDERS: readonly FolderId[] = ['archive', 'spam', 'trash']

/** A closed section still shows while what's on screen lives in it, so the selection never hides. */
export const sectionShown = (prefs: SidebarPrefs, section: SidebarSection, holdsActive: boolean) => prefs.open[section] || holdsActive

/**
 * The Mail badge in the rail: unread Inbox mail across every account, like the Dock badge. The
 * rail is app-wide while the account lives in the column beside it, which already shows this
 * account's Inbox count, so the rail answers "is there new mail anywhere?".
 */
export const mailBadge = (inboxUnread: Record<string, number>) => Object.values(inboxUnread).reduce((total, n) => total + Math.max(0, n), 0)

/** Rail count text: two digits, then 99+. */
export const badgeText = (count: number) => (count > 99 ? '99+' : String(count))

/** A folder count short enough for its badge: 999, 1.2k, 19k, 3.4m. Rounds down so it never overstates. */
export const compactCount = (count: number) => {
  const short = (value: number, unit: string) => {
    const shown = value < 10 ? Math.floor(value * 10) / 10 : Math.floor(value)
    return `${shown}${unit}`
  }
  if (count < 1000) return String(count)
  if (count < 1_000_000) return short(count / 1000, 'k')
  return short(count / 1_000_000, 'm')
}

/** How soon an event has to start for the Calendar icon to show a dot. */
export const SOON_MS = 15 * 60_000

/** An event (timed, not all-day) starting within SOON_MS from now. */
export const startsSoon = (events: ReadonlyArray<{ startAt: number; allDay?: boolean }>, now: number) =>
  events.some((e) => !e.allDay && e.startAt > now && e.startAt - now <= SOON_MS)

export type AppKey = AppName | 'toggleSidebar'

/** ⌘1 Mail, ⌘2 Calendar, ⌘3 Notes, ⌘4 Tasks, ⌘\ shows or hides the context column. */
export function appKeyFor(press: KeyPress): AppKey | null {
  const m = press.modifiers ?? {}
  if (!(m.cmd || m.ctrl) || m.alt || m.shift) return null
  const key = press.key?.toLowerCase()
  return key === '1' ? 'mail' : key === '2' ? 'calendar' : key === '3' ? 'notes' : key === '4' ? 'tasks' : key === '\\' || key === 'backslash' ? 'toggleSidebar' : null
}

/** For the cheat sheet and tooltips. */
export const APP_SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: '⌘1', label: 'Mail' },
  { keys: '⌘2', label: 'Calendar' },
  { keys: '⌘3', label: 'Notes' },
  { keys: '⌘J', label: 'Assistant' },
  { keys: '⌘K', label: 'Search or jump to' },
  { keys: '⌘\\', label: 'Show or hide the sidebar' },
]

export function relativeTime(ts: number, now: number) {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** What the rail's sync dot looks like; `failed` only ever comes from the gated sync view (sync-view.ts). */
export type SyncDot = 'syncing' | 'signIn' | 'offline' | 'failed' | 'ok' | 'never'

export type SyncSummary = { dot: SyncDot; line: string; hint: string }

/** The sync dot's state and its tooltip: one line for what's happening, one for what a click does. */
export function syncSummary({ sync, offline, needsSignIn, outbox, email, now }: { sync: SyncView; offline: boolean; needsSignIn: boolean; outbox: number; email: string; now: number }): SyncSummary {
  const lastChecked = sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
  if (needsSignIn && !offline) return { dot: 'signIn', line: 'Sign in again', hint: `${email} was signed out · Click to sign in` }
  if (offline) return { dot: 'offline', line: outbox > 0 ? `Offline · ${outbox} waiting to send` : 'Offline', hint: 'Mail syncs when you’re back online' }
  if (sync.status === 'syncing') {
    // A revealed background sync stays generic; folder names are for syncs someone is watching.
    const line = sync.background ? 'Updating…' : sync.phase && sync.phase !== 'Connecting' ? `Syncing ${sync.phase}…` : 'Connecting…'
    return { dot: 'syncing', line, hint: lastChecked ? `Last checked ${lastChecked}` : 'Checking for new mail' }
  }
  if (sync.status === 'error') return { dot: 'failed', line: 'Sync failed', hint: `${sync.error ?? "Couldn't reach the server"} · Click to try again` }
  if (!sync.lastSyncedAt) return { dot: 'never', line: 'Not synced yet', hint: 'Click to check for new mail' }
  // A recent sync says "Up to date" rather than a ticking "Synced 12s ago".
  const line = now - sync.lastSyncedAt < FRESH_MS ? 'Up to date' : `Synced ${relativeTime(sync.lastSyncedAt, now)}`
  return { dot: 'ok', line, hint: `Last checked ${lastChecked} · Click to check for new mail` }
}

/** The card at the foot of the context column when a newer Jefi is waiting. */
export type UpdateCard = { version: string; title: string; detail: string; action: 'restart' | 'download'; url?: string }

/** What the update card says, or null: nothing newer, or this version was waved off with Later. */
export function updateCard(state: UpdateState, dismissed: string | null): UpdateCard | null {
  if (state.status === 'ready' && state.version !== dismissed) {
    return { version: state.version, title: `Jefi ${state.version} is ready`, detail: 'Restart to finish updating', action: 'restart' }
  }
  if (state.status === 'manual' && state.version !== dismissed) {
    return { version: state.version, title: `Jefi ${state.version} is available`, detail: 'Download it to update', action: 'download', url: state.url }
  }
  return null
}
