import { zonedToEpoch } from '../detect/tz'
import type { TaskDue } from './model'

// ---------------------------------------------------------------------------
// Reading the model's answer to suggestTasks (src/ai.ts). The text is untrusted: anything that
// isn't a JSON array of well-formed items is dropped rather than guessed at, titles are trimmed
// and capped, and a due that isn't a real ISO date or date-time is left out.
// ---------------------------------------------------------------------------

export type TaskSuggestion = { title: string; quote: string } & TaskDue

const MAX = 5
const TITLE_MAX = 120
const QUOTE_MAX = 200

/** The JSON array in the answer, allowing a code fence or a sentence around it. */
function arrayIn(text: string): unknown[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * "2026-10-02" → that day (UTC midnight, date-only); "2026-10-02T15:00" → 3 PM there in `timeZone`.
 * Seconds are allowed (models add them though asked for HH:MM); an offset or Z isn't guessed at.
 */
export function parseDue(value: unknown, timeZone: string): TaskDue {
  const none = { dueAt: null, dueAllDay: false }
  if (typeof value !== 'string') return none
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/)
  if (!m) return none
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return none
  if (m[4] === undefined) return { dueAt: probe.getTime(), dueAllDay: true }
  const [hour, minute] = [Number(m[4]), Number(m[5])]
  if (hour > 23 || minute > 59) return none
  return { dueAt: zonedToEpoch({ year, month, day, hour, minute, second: 0 }, timeZone), dueAllDay: false }
}

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '')

/** The suggestions in the model's answer: at most five, each with a title, no duplicates. */
export function parseTaskSuggestions(text: string, timeZone: string): TaskSuggestion[] {
  const items = arrayIn(text) ?? []
  const out: TaskSuggestion[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = clean(record.title, TITLE_MAX)
    if (!title || out.some((s) => s.title.toLowerCase() === title.toLowerCase())) continue
    out.push({ title, quote: clean(record.quote, QUOTE_MAX), ...parseDue(record.due, timeZone) })
    if (out.length >= MAX) break
  }
  return out
}

/** Today as the prompt states it, in the person's zone: "Saturday, 2026-09-26". */
export function todayForPrompt(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(new Date(now))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('weekday')}, ${get('year')}-${get('month')}-${get('day')}`
}
