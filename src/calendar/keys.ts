import type { KeyPress } from '../keys'

// ---------------------------------------------------------------------------
// The calendar's keys, live only while the calendar is on screen (the mail keys are off then, since
// the workspace counts the calendar as a tool). Pure, like shortcuts.ts, so it's tested on its own.
// ---------------------------------------------------------------------------

export type CalendarAction = 'today' | 'previous' | 'next' | 'new' | 'day' | 'week' | 'month' | 'agenda' | 'close'

const KEYS: Record<string, CalendarAction> = {
  t: 'today',
  left: 'previous',
  k: 'previous',
  right: 'next',
  j: 'next',
  n: 'new',
  c: 'new',
  d: 'day',
  '1': 'day',
  w: 'week',
  '2': 'week',
  m: 'month',
  '3': 'month',
  a: 'agenda',
  '4': 'agenda',
  escape: 'close',
}

/** What a key does in the calendar, or null to leave it to others. */
export function calendarActionFor(press: KeyPress, context: { typing: boolean; busy: boolean }): CalendarAction | null {
  const m = press.modifiers ?? {}
  if (m.cmd || m.ctrl || m.alt || context.typing || context.busy) return null
  const key = press.key?.toLowerCase()
  if (!key) return null
  return KEYS[key] ?? null
}

/** For the cheat sheet. */
export const CALENDAR_SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'T', label: 'Today' },
  { keys: 'J  →', label: 'Next period' },
  { keys: 'K  ←', label: 'Previous period' },
  { keys: 'N  C', label: 'New event' },
  { keys: 'D  1', label: 'Day view' },
  { keys: 'W  2', label: 'Week view' },
  { keys: 'M  3', label: 'Month view' },
  { keys: 'A  4', label: 'Agenda' },
]
