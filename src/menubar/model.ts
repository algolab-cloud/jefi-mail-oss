import type { MenuBarTitleMode } from '../theme'
import { addDays, displaySpan, monthGrid, startOfDay, startOfMonth, type Weekday } from '../calendar/dates'
import type { EventPrefill } from '../calendar/draft'
import { detectDates } from '../detect/dates'
import { SIGN_IN_RECENT_MS } from '../sign-in-code'

// ---------------------------------------------------------------------------
// What the menu bar shows, as plain data: built from the app's own sources (unread counts, event
// occurrences, and later the recent-notifications buffer and pending invites) by pure functions, so
// the title, the panel and the panel's messages are all tested without AppKit.
// ---------------------------------------------------------------------------

export type MenuBarEvent = {
  /** The occurrence key, which is how the panel asks for it back. */
  key: string
  title: string
  start: number
  end: number
  allDay: boolean
  /** The calendar's colour. */
  color: string
  location: string | null
}

/** Where a recent item leads: a conversation (like a banner click) or an event. */
export type RecentRoute = { type: 'thread'; accountId: string; threadId: string } | { type: 'event'; eventId: string; /** The occurrence's start, as a reminder banner carries it. */ occurrenceStart: number }

/** One entry in the panel's Recent list: a new-mail banner, an invite or a reminder that was shown. */
export type RecentItem = { id: string; kind: 'mail' | 'invite' | 'reminder'; title: string; detail: string; at: number; route: RecentRoute; code?: string }

/** A sign-in code that arrived in the last quarter hour, copied from the panel in one click. */
export type SignInCodeItem = { id: string; title: string; code: string; at: number }

/** An invitation still waiting for this person's answer. `start` is the engine's startAt (a UTC midnight when all-day). */
export type InviteSummary = { eventId: string; title: string; start: number; allDay: boolean; organizer: string }

export type MonthDay = { date: number; inMonth: boolean; today: boolean; busy: boolean }

/** A task that's overdue or due today, as the panel lists it; `due` is already the text to show. */
export type MenuBarTask = { id: string; title: string; due: string; overdue: boolean }

export type MenuBarModel = {
  now: number
  unread: number
  /** The next timed event that hasn't ended, within a week. */
  upNext: MenuBarEvent | null
  /** Everything on today, all-day first. */
  today: MenuBarEvent[]
  month: { start: number; firstDay: Weekday; days: MonthDay[] }
  recent: RecentItem[]
  /** Sign-in codes from the last SIGN_IN_RECENT_MS, newest first. */
  codes: SignInCodeItem[]
  pendingInvites: InviteSummary[]
  /** Overdue first, then due today, at most MENU_BAR_TASKS; `tasksMore` counts the rest. */
  tasks: MenuBarTask[]
  tasksMore: number
}

/** How many tasks the panel lists before "N more". */
export const MENU_BAR_TASKS = 4

/** The occurrence fields the model reads (EventOccurrence has them all). */
export type OccurrenceLike = { key: string; title: string; startAt: number; endAt: number; allDay: boolean; calendarId: string; location?: string | null }

const UP_NEXT_HORIZON = 7

/** The range of occurrences buildMenuBarModel needs: this month's grid, and a week ahead for Up next. */
export function modelRange(now: number, firstDay: Weekday): { from: number; to: number } {
  const grid = monthGrid(now, firstDay)
  const today = startOfDay(now)
  return { from: Math.min(grid[0]!, today), to: Math.max(addDays(grid[41]!, 1), addDays(today, UP_NEXT_HORIZON + 1)) }
}

export function buildMenuBarModel(input: {
  now: number
  unread: number
  occurrences: readonly OccurrenceLike[]
  colorOf: (calendarId: string) => string
  firstDay: Weekday
  recent?: readonly RecentItem[]
  pendingInvites?: readonly InviteSummary[]
  tasks?: readonly MenuBarTask[]
}): MenuBarModel {
  const { now, firstDay } = input
  const events = input.occurrences.map((o): MenuBarEvent & { span: { start: number; end: number } } => ({
    key: o.key,
    title: o.title.trim() || '(No title)',
    start: o.startAt,
    end: o.endAt,
    allDay: o.allDay,
    color: input.colorOf(o.calendarId),
    location: o.location?.trim() || null,
    span: displaySpan(o),
  }))
  const today = startOfDay(now)
  const tomorrow = addDays(today, 1)
  const strip = ({ span: _, ...event }: MenuBarEvent & { span: unknown }): MenuBarEvent => event
  const todays = events
    .filter((e) => e.span.start < tomorrow && e.span.end > today)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title))
    .map(strip)
  const next = events
    .filter((e) => !e.allDay && e.end > now && e.start < addDays(today, UP_NEXT_HORIZON))
    .sort((a, b) => a.start - b.start || a.end - b.end)[0]
  const grid = monthGrid(now, firstDay)
  const busy = new Set<number>()
  for (const e of events) {
    for (let d = startOfDay(e.span.start); d < e.span.end && d <= grid[41]!; d = addDays(d, 1)) busy.add(d)
  }
  const monthStart = startOfMonth(now)
  const month = new Date(monthStart).getMonth()
  return {
    now,
    unread: Math.max(0, Math.floor(input.unread)),
    upNext: next ? strip(next) : null,
    today: todays,
    month: { start: monthStart, firstDay, days: grid.map((date) => ({ date, inMonth: new Date(date).getMonth() === month, today: date === today, busy: busy.has(date) })) },
    recent: [...(input.recent ?? [])].sort((a, b) => b.at - a.at).slice(0, 5),
    codes: [...(input.recent ?? [])]
      .filter((r): r is RecentItem & { code: string } => !!r.code && now - r.at < SIGN_IN_RECENT_MS)
      .sort((a, b) => b.at - a.at)
      .map((r) => ({ id: r.id, title: r.title, code: r.code, at: r.at })),
    pendingInvites: [...(input.pendingInvites ?? [])].sort((a, b) => a.start - b.start).slice(0, 3),
    tasks: (input.tasks ?? []).slice(0, MENU_BAR_TASKS),
    tasksMore: Math.max(0, (input.tasks?.length ?? 0) - MENU_BAR_TASKS),
  }
}

/**
 * "in 25m", "in 2h 5m", "in 3d", "ends in 10m": how far off an event is. Self-contained on purpose:
 * the panel's page runs this same function (by its source) to keep the countdown live.
 */
export function untilText(start: number, end: number, now: number): string {
  const span = (ms: number) => {
    const minutes = Math.max(1, Math.ceil(ms / 60000))
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours >= 24) return `${Math.round(hours / 24)}d`
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m` : `${hours}h`
  }
  if (now >= start) return now < end ? `ends in ${span(end - now)}` : 'ended'
  return `in ${span(start - now)}`
}

/** Menu bar titles are cut this short: a long one slides under the notch and the item vanishes. */
const TITLE_CHARS = 14

const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/**
 * The text beside the menu bar icon. Unread: the count ("12", "999+"), nothing at zero. Next event:
 * "Standup in 25m" within the hour, "Standup now" for its first five minutes, nothing otherwise, so
 * the item stays narrow most of the day.
 */
export function menuBarTitle(input: { mode: MenuBarTitleMode; unread: number; events: readonly Pick<MenuBarEvent, 'title' | 'start' | 'end' | 'allDay'>[]; now: number }): string {
  if (input.mode === 'unread') return input.unread <= 0 ? '' : input.unread > 999 ? '999+' : String(Math.floor(input.unread))
  if (input.mode !== 'next') return ''
  const { now } = input
  const soon = input.events
    .filter((e) => !e.allDay && e.start - now <= 60 * 60000 && now - e.start < 5 * 60000 && e.end > now)
    .sort((a, b) => a.start - b.start)[0]
  if (!soon) return ''
  const title = shorten(soon.title.trim() || 'Event', TITLE_CHARS)
  return soon.start <= now ? `${title} now` : `${title} ${untilText(soon.start, soon.end, now)}`
}

// --- Messages from the panel ---------------------------------------------------------------------

export const PANEL_ACTIONS = ['open-jefi', 'open-event', 'open-day', 'open-invite', 'open-recent', 'copy-code', 'open-task', 'toggle-task', 'open-tasks', 'compose', 'new-event', 'new-note', 'new-task', 'quick-add', 'settings', 'quit', 'height'] as const
export type PanelAction = (typeof PANEL_ACTIONS)[number]
export type PanelMessage = { type: PanelAction; arg: string }

/** The page is ours, but its messages are still checked: a known action and a short string argument. */
export function parsePanelMessage(raw: string): PanelMessage | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return null
    const { type, arg } = value as { type?: unknown; arg?: unknown }
    if (typeof type !== 'string' || !(PANEL_ACTIONS as readonly string[]).includes(type)) return null
    if (arg !== undefined && (typeof arg !== 'string' || arg.length > 500)) return null
    return { type: type as PanelAction, arg: arg ?? '' }
  } catch {
    return null
  }
}

/**
 * "Task: Send the deck Friday" (or "Todo: …") in the quick-add field is a task, not an event: the
 * text after the prefix, '' for the prefix alone (a new task, still to be written), or null for
 * anything else. The colon is required, so "Task force sync Friday" stays an event.
 */
export function quickAddTask(text: string): string | null {
  const m = text.match(/^\s*(?:task|todo|to-do)\s*[:–-]\s*(.*)$/i)
  return m ? m[1]!.trim() : null
}

/**
 * The quick-add field: "Lunch with Nora Friday 1pm" → an editor prefill titled "Lunch with Nora" on
 * Friday at 1 PM, through the same on-device date detection the reader uses. Without a date it
 * still opens the editor, titled with what was typed.
 */
export function quickAddPrefill(text: string, now: number, timeZone: string): EventPrefill {
  const typed = text.replace(/\s+/g, ' ').trim()
  if (!typed) return {}
  const found = detectDates({ text: typed, sentAt: now, timeZone, locale: 'en' })[0]
  if (!found) return { title: typed }
  const rest = `${typed.slice(0, found.index)} ${typed.slice(found.index + found.length)}`
    .replace(/\s+/g, ' ')
    .replace(/\s*\b(?:on|at|this|next|for)\s*$/i, '')
    .replace(/[\s,;:·-]+$/, '')
    .trim()
  return { title: rest || found.title || typed, start: found.start, end: found.end, allDay: found.allDay }
}
