import * as chrono from 'chrono-node'
import { addDays, allDayToLocal, startOfDay } from '../calendar/dates'
import type { MailThread, Message } from '../data'
import { offsetMinutes, wallTime, zonedToEpoch } from '../detect/tz'
import type { IconName } from '../icons'
import type { Task, TaskInput, TaskPriority, TaskProject, TaskQuery, TaskStatus } from '../engine'
import { restorableTargets } from '../notes/model'
import { splitQuoted } from '../mail-text'
import { messageText } from '../reply'
import { cleanSubject, detectForMessage, userTimeZone } from '../reader-calendar/suggest'

// ---------------------------------------------------------------------------
// The tasks feature's pure pieces: statuses and priorities as the UI shows them, the sidebar's
// views, grouping, ordering and filtering the list, reading a due date out of what was typed, how
// a due date reads, and a task drafted from an email. A date-only due is stored as its day's UTC
// midnight (like an all-day event); a timed one as the instant.
// ---------------------------------------------------------------------------

// --- Statuses and priorities --------------------------------------------------------

export type Tone = 'muted' | 'secondary' | 'amber' | 'accent' | 'red' | 'green'
export type StatusMeta = { status: TaskStatus; label: string; icon: IconName; tone: Tone }
/** In workflow order. */
export const STATUSES: readonly StatusMeta[] = [
  { status: 'backlog', label: 'Backlog', icon: 'statusBacklog', tone: 'muted' },
  { status: 'todo', label: 'Todo', icon: 'statusTodo', tone: 'secondary' },
  { status: 'in_progress', label: 'In Progress', icon: 'statusInProgress', tone: 'amber' },
  { status: 'done', label: 'Done', icon: 'statusDone', tone: 'accent' },
  { status: 'canceled', label: 'Canceled', icon: 'statusCanceled', tone: 'muted' },
]
export const statusMeta = (status: TaskStatus) => STATUSES.find((s) => s.status === status)!
export const isClosed = (status: TaskStatus) => status === 'done' || status === 'canceled'

export type PriorityMeta = { priority: TaskPriority; label: string; icon: IconName; tone: Tone }
/** Urgent first, the order Linear lists them; no priority last. */
export const PRIORITIES: readonly PriorityMeta[] = [
  { priority: 0, label: 'No priority', icon: 'priorityNone', tone: 'muted' },
  { priority: 1, label: 'Urgent', icon: 'priorityUrgent', tone: 'red' },
  { priority: 2, label: 'High', icon: 'priorityHigh', tone: 'secondary' },
  { priority: 3, label: 'Medium', icon: 'priorityMedium', tone: 'secondary' },
  { priority: 4, label: 'Low', icon: 'priorityLow', tone: 'secondary' },
]
export const priorityMeta = (priority: TaskPriority) => PRIORITIES.find((p) => p.priority === priority)!
/** Sort rank: urgent 1 … low 4, none 5. */
const rank = (priority: TaskPriority) => (priority === 0 ? 5 : priority)

/** The label or project called `name`, ignoring case and outer spaces. */
export const named = <T extends { name: string }>(items: readonly T[], name: string): T | undefined => {
  const wanted = name.replace(/\s+/g, ' ').trim().toLowerCase()
  return wanted ? items.find((item) => item.name.toLowerCase() === wanted) : undefined
}

/** "T-12". */
export const taskKey = (task: Pick<Task, 'number'>) => `T-${task.number}`

// --- Views -----------------------------------------------------------------------

/** The sidebar's views; a project or label narrows to its tasks. */
export type TaskView = 'active' | 'today' | 'upcoming' | 'backlog' | 'all' | 'done' | `project:${string}` | `label:${string}`

export const VIEWS: ReadonlyArray<{ view: TaskView; label: string; icon: IconName }> = [
  { view: 'active', label: 'Active', icon: 'statusInProgress' },
  { view: 'today', label: 'Today', icon: 'calendar' },
  { view: 'upcoming', label: 'Upcoming', icon: 'calendarDays' },
  { view: 'backlog', label: 'Backlog', icon: 'statusBacklog' },
  { view: 'all', label: 'All tasks', icon: 'listTodo' },
  { view: 'done', label: 'Completed', icon: 'statusDone' },
]

/** What to ask the engine for a view; `keep` narrows the answer further on the person's clock. */
export function viewQuery(view: TaskView, now: number): { query: TaskQuery; keep?: (task: Task) => boolean } {
  if (view.startsWith('project:')) return { query: { status: 'all', projectId: view.slice(8) } }
  if (view.startsWith('label:')) return { query: { status: 'all', labelId: view.slice(6) } }
  const today = startOfDay(now)
  switch (view) {
    case 'active':
      return { query: { status: ['todo', 'in_progress'] } }
    case 'backlog':
      return { query: { status: ['backlog'] } }
    case 'today':
      return { query: { status: 'open' }, keep: (t) => { const d = dueDay(t); return d !== null && d <= today } }
    case 'upcoming':
      return { query: { status: 'open' }, keep: (t) => { const d = dueDay(t); return d !== null && d > today } }
    case 'done':
      return { query: { status: 'closed', limit: 300 } }
    default:
      return { query: { status: 'open' } }
  }
}

/**
 * What a task made in a view starts with, so it shows in the view it was made in: a project's or
 * label's view sets it, Backlog makes it backlog, and Today and Upcoming give it a due (today,
 * tomorrow) when none was typed.
 */
export function viewPrefill(view: TaskView, now: number): Omit<TaskInput, 'id'> {
  if (view.startsWith('project:')) return { projectId: view.slice(8) }
  if (view.startsWith('label:')) return { labelIds: [view.slice(6)] }
  if (view === 'backlog') return { status: 'backlog' }
  const [today, tomorrow] = dueShortcuts(now)
  if (view === 'today') return withDueDay({ dueAt: null, dueAllDay: true }, today!.day)
  if (view === 'upcoming') return withDueDay({ dueAt: null, dueAllDay: true }, tomorrow!.day)
  return {}
}

/** The quick-add line's task: the typed text and its date, in the view's scope (a typed date wins). */
export function quickAddInput(text: string, view: TaskView, now: number, timeZone = userTimeZone()): Omit<TaskInput, 'id'> & { title: string } {
  const parsed = parseTaskText(text, now, timeZone)
  const scope = viewPrefill(view, now)
  const due = parsed.dueAt !== null ? { dueAt: parsed.dueAt, dueAllDay: parsed.dueAllDay } : scope.dueAt != null ? { dueAt: scope.dueAt, dueAllDay: scope.dueAllDay ?? true } : { dueAt: null, dueAllDay: false }
  return { ...scope, title: parsed.title, ...due, origin: 'manual' }
}

/**
 * The number beside a view's title: its open tasks, the same number the sidebar shows for it. A
 * project or label lists its done and canceled tasks too (under Done), but they are not counted;
 * Completed counts what it lists.
 */
export const viewCount = (view: TaskView, tasks: readonly Pick<Task, 'status'>[]) => (view === 'done' ? tasks.length : tasks.filter((t) => !isClosed(t.status)).length)

export const viewLabel = (view: TaskView, projects: readonly TaskProject[], labels: ReadonlyArray<{ id: string; name: string }>) =>
  view.startsWith('project:') ? (projects.find((p) => p.id === view.slice(8))?.name ?? 'Project') : view.startsWith('label:') ? (labels.find((l) => l.id === view.slice(6))?.name ?? 'Label') : (VIEWS.find((v) => v.view === view)?.label ?? 'Tasks')

// --- Display: grouping, ordering, filtering -------------------------------------------

export type GroupBy = 'status' | 'priority' | 'project' | 'due' | 'none'
export type OrderBy = 'priority' | 'due' | 'created' | 'updated'
export type TaskFilter = { labelIds: string[]; projectIds: string[]; priorities: TaskPriority[] }
export const NO_FILTER: TaskFilter = { labelIds: [], projectIds: [], priorities: [] }
export const filterCount = (f: TaskFilter) => f.labelIds.length + f.projectIds.length + f.priorities.length

/** Tasks matching every kind of filter that's set (any label of the chosen ones, and so on). */
export function filterTasks(tasks: readonly Task[], f: TaskFilter): Task[] {
  return tasks.filter(
    (t) =>
      (!f.labelIds.length || t.labels.some((l) => f.labelIds.includes(l.id))) &&
      (!f.projectIds.length || (t.projectId !== null && f.projectIds.includes(t.projectId))) &&
      (!f.priorities.length || f.priorities.includes(t.priority)),
  )
}

const byDue = (a: Task, b: Task) => (a.dueAt === null ? 1 : 0) - (b.dueAt === null ? 1 : 0) || (a.dueAt ?? 0) - (b.dueAt ?? 0)
const ORDERS: Record<OrderBy, (a: Task, b: Task) => number> = {
  priority: (a, b) => rank(a.priority) - rank(b.priority) || byDue(a, b) || b.createdAt - a.createdAt,
  due: (a, b) => byDue(a, b) || rank(a.priority) - rank(b.priority) || b.createdAt - a.createdAt,
  created: (a, b) => b.createdAt - a.createdAt || b.number - a.number,
  updated: (a, b) => b.updatedAt - a.updatedAt || b.number - a.number,
}
export const sortTasks = (tasks: readonly Task[], order: OrderBy) => [...tasks].sort(ORDERS[order])

export type ListGroup = { key: string; label: string; icon?: IconName; tone?: Tone; color?: string; tasks: Task[]; prefill: Partial<TaskInput> }

/**
 * The list's groups for a Display setting, each in `order`. Status and priority groups come in
 * their own order (with `empty` ones kept, for a board's columns); projects by name, then none.
 */
export function groupBy(tasks: readonly Task[], by: GroupBy, order: OrderBy, context: { now: number; projects: readonly TaskProject[]; empty?: boolean }): ListGroup[] {
  const sorted = sortTasks(tasks, order)
  const keep = (groups: ListGroup[]) => (context.empty ? groups : groups.filter((g) => g.tasks.length))
  if (by === 'status') {
    // A list leads with what's under way, like Linear; a board's columns run in workflow order.
    const order = context.empty ? STATUSES : (['in_progress', 'todo', 'backlog', 'done', 'canceled'] as const).map(statusMeta)
    return keep(order.map((s) => ({ key: s.status, label: s.label, icon: s.icon, tone: s.tone, tasks: sorted.filter((t) => t.status === s.status), prefill: { status: s.status } })))
  }
  if (by === 'priority') {
    return keep([...PRIORITIES.slice(1), PRIORITIES[0]!].map((p) => ({ key: String(p.priority), label: p.label, icon: p.icon, tone: p.tone, tasks: sorted.filter((t) => t.priority === p.priority), prefill: { priority: p.priority } })))
  }
  if (by === 'project') {
    const projects = [...context.projects].sort((a, b) => a.name.localeCompare(b.name))
    return keep([
      ...projects.map((p) => ({ key: p.id, label: p.name, icon: 'folder' as IconName, color: p.color, tasks: sorted.filter((t) => t.projectId === p.id), prefill: { projectId: p.id } })),
      { key: 'none', label: 'No project', icon: 'folder' as IconName, tone: 'muted' as Tone, tasks: sorted.filter((t) => !t.projectId || !projects.some((p) => p.id === t.projectId)), prefill: {} },
    ])
  }
  if (by === 'due') {
    const closed = sorted.filter((t) => isClosed(t.status))
    const open = groupTasks(sorted, context.now).map((g) => ({ key: g.key, label: g.label, icon: DUE_ICON[g.key], tone: (g.key === 'overdue' ? 'red' : undefined) as Tone | undefined, tasks: g.tasks, prefill: duePrefill(g.key, context.now) }))
    return [...open, ...(closed.length ? [{ key: 'closed', label: 'Completed', icon: 'statusDone' as IconName, tone: 'accent' as Tone, tasks: closed, prefill: { status: 'done' as TaskStatus } }] : [])]
  }
  return sorted.length ? [{ key: 'all', label: '', tasks: sorted, prefill: {} }] : []
}

const DUE_ICON: Record<TaskGroupKey, IconName> = { overdue: 'alertCircle', today: 'calendar', upcoming: 'calendarDays', someday: 'statusTodo' }

/** What a due group's + prefills: its due date (overdue work lands on today). */
function duePrefill(key: TaskGroupKey, now: number): Partial<TaskInput> {
  const [today, tomorrow] = dueShortcuts(now)
  if (key === 'overdue' || key === 'today') return withDueDay({ dueAt: null, dueAllDay: true }, today!.day)
  if (key === 'upcoming') return withDueDay({ dueAt: null, dueAllDay: true }, tomorrow!.day)
  return {}
}

/**
 * Where J/K land in a list of `count` rows, from the row at `at`. When the current task has left the
 * list (completed with its sheet open), `at` is -1 and `lastAt` is where it was last seen: the rows
 * after it have moved up one, so J lands on the one that followed it and K on the one before.
 */
export function stepIndex(count: number, at: number, by: 1 | -1, lastAt: number | null = null): number {
  if (!count) return -1
  const from = at >= 0 ? at + by : lastAt !== null ? (by > 0 ? lastAt : lastAt - 1) : 0
  return Math.max(0, Math.min(count - 1, from))
}

export type TaskDue = { dueAt: number | null; dueAllDay: boolean }

/** Words left dangling once the date is cut out of "Send the deck by Friday". */
const DANGLING = /\s*\b(?:on|at|by|due|before|until|this|next|for|in)\s*$/i

/**
 * "Send the deck Friday 3pm" → "Send the deck", due Friday at 3 PM in `timeZone`. Casual phrases
 * count too ("tomorrow", "next week", "in 2 weeks"), unlike event detection. The last date in the
 * text wins, since that's where people put it. Without one, the text is the title and there's no due.
 */
export function parseTaskText(text: string, now: number, timeZone = userTimeZone()): { title: string } & TaskDue {
  const typed = text.replace(/\s+/g, ' ').trim()
  const parse = (instant: number) => chrono.casual.parse(typed, { instant: new Date(instant), timezone: offsetMinutes(now, timeZone) }, { forwardDate: true }).at(-1)
  let found = parse(now)
  if (!found) return { title: typed, dueAt: null, dueAllDay: false }
  // forwardDate measures from this minute, so a day named without a year ("Sep 26", "9/26",
  // "Saturday") typed on that very day after noon jumped a year (or a week) ahead. A named day is
  // read from the start of today instead; a bare time ("at 7am") still means the next one.
  if (!found.start.isCertain('year') && (found.start.isCertain('day') || found.start.isCertain('weekday'))) {
    const w = wallTime(now, timeZone)
    const again = parse(zonedToEpoch({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0, second: 0 }, timeZone))
    if (again && again.index === found.index && again.text === found.text) found = again
  }
  const title = `${typed.slice(0, found.index)} ${typed.slice(found.index + found.text.length)}`.replace(/\s+/g, ' ').replace(DANGLING, '').replace(/[\s,;:·-]+$/, '').trim()
  const c = found.start
  const timed = c.isCertain('hour')
  const [year, month, day] = [c.get('year')!, c.get('month')!, c.get('day')!]
  const dueAt = !timed
    ? Date.UTC(year, month - 1, day)
    : c.isCertain('timezoneOffset')
      ? c.date().getTime()
      : zonedToEpoch({ year, month, day, hour: c.get('hour') ?? 0, minute: c.get('minute') ?? 0, second: 0 }, timeZone)
  return { title: title || typed, dueAt, dueAllDay: !timed }
}

/** The local midnight of the day a task is due, or null. */
export const dueDay = (task: Pick<Task, 'dueAt' | 'dueAllDay'>): number | null => (task.dueAt === null ? null : task.dueAllDay ? allDayToLocal(task.dueAt) : startOfDay(task.dueAt))

/** Past due: a date-only task from yesterday back, a timed one once its time has passed. */
export function isOverdue(task: Pick<Task, 'dueAt' | 'dueAllDay' | 'status'>, now: number): boolean {
  if (isClosed(task.status) || task.dueAt === null) return false
  return task.dueAllDay ? dueDay(task)! < startOfDay(now) : task.dueAt < now
}

export type TaskGroupKey = 'overdue' | 'today' | 'upcoming' | 'someday'
export type TaskGroup = { key: TaskGroupKey; label: string; tasks: Task[] }

const LABELS: Record<TaskGroupKey, string> = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', someday: 'No date' }

/** Open tasks in the pane's groups, in list order within each; empty groups are left out. */
export function groupTasks(tasks: readonly Task[], now: number): TaskGroup[] {
  const today = startOfDay(now)
  const groups: Record<TaskGroupKey, Task[]> = { overdue: [], today: [], upcoming: [], someday: [] }
  for (const task of tasks) {
    if (isClosed(task.status)) continue
    const day = dueDay(task)
    const key: TaskGroupKey = day === null ? 'someday' : isOverdue(task, now) ? 'overdue' : day === today ? 'today' : 'upcoming'
    groups[key].push(task)
  }
  return (Object.keys(groups) as TaskGroupKey[]).filter((k) => groups[k].length).map((key) => ({ key, label: LABELS[key], tasks: groups[key] }))
}

/** Overdue plus due today: the number on the rail's Tasks icon and the Dock-style badge. */
export const dueCount = (tasks: readonly Task[], now: number) => groupTasks(tasks, now).reduce((n, g) => (g.key === 'overdue' || g.key === 'today' ? n + g.tasks.length : n), 0)

const time = (ms: number, locale?: string) => new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })

/** "Today", "Tomorrow · 3:00 PM", "Friday", "Oct 3", "Oct 3, 2027": how a due date reads in a row. */
export function dueText(task: Pick<Task, 'dueAt' | 'dueAllDay'>, now: number, locale?: string): string {
  const day = dueDay(task)
  if (day === null) return ''
  const today = startOfDay(now)
  const days = Math.round((day - today) / 86_400_000)
  const date =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Tomorrow'
        : days === -1
          ? 'Yesterday'
          : days > 1 && days < 7
            ? new Date(day).toLocaleDateString(locale, { weekday: 'long' })
            : new Date(day).toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(new Date(day).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })
  return task.dueAllDay ? date : `${date} · ${time(task.dueAt!, locale)}`
}

/** A due on a picked local day: date-only keeps its UTC midnight, a timed one keeps its time of day. */
export function withDueDay(task: TaskDue, localDay: number): TaskDue {
  const d = new Date(localDay)
  if (task.dueAt === null || task.dueAllDay) return { dueAt: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()), dueAllDay: true }
  const at = new Date(task.dueAt)
  return { dueAt: new Date(d.getFullYear(), d.getMonth(), d.getDate(), at.getHours(), at.getMinutes()).getTime(), dueAllDay: false }
}

/** Quick picks for a due date, as local days. */
export const dueShortcuts = (now: number) => {
  const today = startOfDay(now)
  const monday = addDays(today, ((8 - new Date(today).getDay()) % 7) || 7)
  return [
    { label: 'Today', day: today },
    { label: 'Tomorrow', day: addDays(today, 1) },
    { label: 'Next week', day: monday },
  ]
}

/** A task's inputs back from it, links included, so Undo after a delete puts the same task back. */
export const restorableTask = (task: Task): TaskInput => ({
  title: task.title,
  notes: task.notes,
  dueAt: task.dueAt,
  dueAllDay: task.dueAllDay,
  status: task.status,
  priority: task.priority,
  projectId: task.projectId,
  labelIds: task.labels.map((l) => l.id),
  alarms: task.alarms,
  origin: task.origin,
  links: restorableTargets(task),
  number: task.number,
})

export type TaskDraft = { title: string } & TaskDue

/**
 * "Make task" from an email: the subject (Re:/Fwd: dropped) as the title, and the first date the
 * message mentions that's still ahead as the due. A timed mention keeps its time.
 */
export function taskDraftFromMessage(thread: Pick<MailThread, 'subject'>, message: Message, now: number, timeZone = userTimeZone()): TaskDraft {
  const title = cleanSubject(thread.subject)
  const next = detectForMessage(message, thread.subject, timeZone).find((s) => (s.end ?? s.start) > now)
  if (!next) {
    // Event detection skips a bare day, but "by Friday" is how a deadline is asked for.
    const deadline = message.timestamp !== undefined ? deadlineIn(splitQuoted(messageText(message)).body, message.timestamp, now, timeZone) : null
    return { title, ...(deadline ?? { dueAt: null, dueAllDay: false }) }
  }
  if (!next.allDay) return { title, dueAt: next.start, dueAllDay: false }
  const w = wallTime(next.start, timeZone)
  return { title, dueAt: Date.UTC(w.year, w.month - 1, w.day), dueAllDay: true }
}

/** Words that make the date after them a deadline: "by Friday", "due on the 3rd", "no later than Oct 3". */
const DEADLINE_BEFORE = /\b(?:by|before|until|till|due(?:\s+(?:on|by))?|deadline(?:\s+is)?:?|no\s+later\s+than)\s+(?:(?:the|this|next|end\s+of)\s+)?$/i

/**
 * The first deadline in `text` that's still ahead: a day (or a day and a time) right after "by",
 * "due", "before", "until" or "no later than", read from when the mail was sent. A bare time ("by
 * 5pm") has no day to hang on and is left out, as is anything already past.
 */
export function deadlineIn(text: string, sentAt: number, now: number, timeZone: string): TaskDue | null {
  const results = chrono.casual.parse(text.slice(0, 20_000), { instant: new Date(sentAt), timezone: offsetMinutes(sentAt, timeZone) }, { forwardDate: true })
  const today = wallTime(now, timeZone)
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day)
  for (const r of results) {
    if (!DEADLINE_BEFORE.test(text.slice(Math.max(0, r.index - 30), r.index))) continue
    const c = r.start
    if (!(c.isCertain('day') || c.isCertain('weekday'))) continue
    // forwardDate turns a yearless "September 1" just gone into next year's; that's never the deadline.
    if (!c.isCertain('year') && c.isCertain('month') && c.date().getTime() > sentAt + 300 * 86_400_000) continue
    const [year, month, day] = [c.get('year')!, c.get('month')!, c.get('day')!]
    if (!c.isCertain('hour')) {
      const dueAt = Date.UTC(year, month - 1, day)
      if (dueAt >= todayUtc) return { dueAt, dueAllDay: true }
      continue
    }
    const dueAt = c.isCertain('timezoneOffset') ? c.date().getTime() : zonedToEpoch({ year, month, day, hour: c.get('hour') ?? 0, minute: c.get('minute') ?? 0, second: 0 }, timeZone)
    if (dueAt > now) return { dueAt, dueAllDay: false }
  }
  return null
}
