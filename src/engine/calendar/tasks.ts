import type { MailDatabase } from '../db'
import { THREAD_MATCH, linkOf, mailLinkColumns, threadMatchArgs, type LinkRow } from './links'
import { newId } from './store'
import type { LinkSnapshot, LinkTarget, Task, TaskInput, TaskLabel, TaskLink, TaskOrigin, TaskPriority, TaskProject, TaskQuery, TaskStatus } from './types'

// ---------------------------------------------------------------------------
// Tasks (docs/tasks-architecture.md): local, belonging to no account, searchable (task_search,
// FTS5), linked to mail, events and people the way notes are. Each has a workflow status, a
// priority, a number (T-12), an optional project and any labels. A date-only due is its UTC
// midnight with due_all_day = 1; "today" and "overdue" are the UI's to work out on the person's clock.
// ---------------------------------------------------------------------------

type TaskRow = {
  n: number
  id: string
  uid: string
  number: number
  title: string
  notes: string
  status: TaskStatus
  priority: number
  project_id: string | null
  due_at: number | null
  due_all_day: number
  remind_at: number | null
  alarms_json: string | null
  origin: string
  completed_at: number | null
  created_at: number
  updated_at: number
}

export const TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'done', 'canceled']
export const CLOSED: readonly TaskStatus[] = ['done', 'canceled']
const OPEN: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress']
const ORIGINS: readonly TaskOrigin[] = ['manual', 'email', 'ai', 'menubar']
const isClosed = (status: TaskStatus) => CLOSED.includes(status)

const LINK_COLUMNS = 'l.id, l.task_id, l.kind, l.account_id, l.target_ref, l.message_id_header, l.snapshot_json, l.created_at'
/** Priority for sorting: urgent first, no priority last. */
const RANK = 'CASE t.priority WHEN 0 THEN 5 ELSE t.priority END'
const OPEN_ORDER = `t.due_at IS NULL, t.due_at, ${RANK}, t.created_at DESC, t.n DESC`
const CLOSED_ORDER = 't.completed_at DESC, t.n DESC'
const CLOSED_SQL = "t.status IN ('done', 'canceled')"
const ALL_ORDER = `${CLOSED_SQL}, CASE WHEN ${CLOSED_SQL} THEN NULL ELSE t.due_at IS NULL END, CASE WHEN ${CLOSED_SQL} THEN NULL ELSE t.due_at END, CASE WHEN ${CLOSED_SQL} THEN NULL ELSE ${RANK} END, t.completed_at DESC, t.created_at DESC, t.n DESC`

function linksOf(db: MailDatabase, taskIds: string[]): Map<string, TaskLink[]> {
  const out = new Map<string, TaskLink[]>()
  if (!taskIds.length) return out
  const rows = db.query(`SELECT ${LINK_COLUMNS} FROM task_links l WHERE l.task_id IN (SELECT value FROM json_each(?)) ORDER BY l.created_at, l.rowid`).all(JSON.stringify(taskIds)) as Array<
    LinkRow & { task_id: string }
  >
  for (const row of rows) out.set(row.task_id, [...(out.get(row.task_id) ?? []), { ...linkOf(db, row), taskId: row.task_id }])
  return out
}

function labelsOf(db: MailDatabase, taskIds: string[]): Map<string, TaskLabel[]> {
  const out = new Map<string, TaskLabel[]>()
  if (!taskIds.length) return out
  const rows = db
    .query('SELECT ll.task_id, l.id, l.name, l.color FROM task_label_links ll JOIN task_labels l ON l.id = ll.label_id WHERE ll.task_id IN (SELECT value FROM json_each(?)) ORDER BY l.name COLLATE NOCASE')
    .all(JSON.stringify(taskIds)) as Array<TaskLabel & { task_id: string }>
  for (const { task_id, ...label } of rows) out.set(task_id, [...(out.get(task_id) ?? []), label])
  return out
}

function tasksOf(db: MailDatabase, rows: TaskRow[]): Task[] {
  const ids = rows.map((r) => r.id)
  const links = linksOf(db, ids)
  const labels = labelsOf(db, ids)
  return rows.map((r) => ({
    id: r.id,
    uid: r.uid,
    number: r.number,
    title: r.title,
    notes: r.notes,
    status: r.status,
    priority: Math.max(0, Math.min(4, r.priority)) as TaskPriority,
    projectId: r.project_id,
    labels: labels.get(r.id) ?? [],
    dueAt: r.due_at,
    dueAllDay: r.due_all_day === 1,
    remindAt: r.remind_at,
    alarms: r.alarms_json === null ? null : (JSON.parse(r.alarms_json) as number[]),
    origin: (ORIGINS as readonly string[]).includes(r.origin) ? (r.origin as TaskOrigin) : 'manual',
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    links: links.get(r.id) ?? [],
  }))
}

/** Each word as a quoted prefix term, so any input is a valid query and "meet" finds "meeting". */
const matchQuery = (query: string) =>
  query
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ''))
    .filter(Boolean)
    .map((word) => `"${word}"*`)
    .join(' ')

/** A date-only due snaps to its UTC midnight, like an all-day event's start. */
const snapDue = (dueAt: number | null, allDay: boolean) => (dueAt === null || !allDay ? dueAt : Math.floor(dueAt / 86_400_000) * 86_400_000)

/** Open tasks by due date (none last), priority, then newest; closed ones latest closed first. */
export function listTasks(db: MailDatabase, query: TaskQuery = {}): Task[] {
  const status = query.status ?? 'open'
  const statuses = status === 'open' ? OPEN : status === 'closed' ? CLOSED : status === 'all' ? null : status
  const where: string[] = []
  const args: Array<string | number> = []
  if (statuses) {
    where.push('t.status IN (SELECT value FROM json_each(?))')
    args.push(JSON.stringify(statuses))
  }
  if (query.projectId) {
    where.push('t.project_id = ?')
    args.push(query.projectId)
  }
  if (query.labelId) {
    where.push('t.id IN (SELECT task_id FROM task_label_links WHERE label_id = ?)')
    args.push(query.labelId)
  }
  const match = query.search?.trim() ? matchQuery(query.search) : ''
  if (match) {
    where.push('t.n IN (SELECT rowid FROM task_search WHERE task_search MATCH ?)')
    args.push(match)
  }
  const order = statuses && statuses.every(isClosed) ? CLOSED_ORDER : statuses && !statuses.some(isClosed) ? OPEN_ORDER : ALL_ORDER
  const limit = query.limit && query.limit > 0 ? ` LIMIT ${Math.floor(query.limit)}` : ''
  const rows = db.query(`SELECT t.* FROM tasks t${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}${limit}`).all(...args) as TaskRow[]
  return tasksOf(db, rows)
}

export function getTask(db: MailDatabase, id: string): Task | null {
  const row = db.query('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | null
  return row ? tasksOf(db, [row])[0]! : null
}

function checkPriority(priority: number): TaskPriority {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) throw new Error('Priority is 0 (none) to 4 (low)')
  return priority as TaskPriority
}

/** Reminder minutes: whole, within a year either way, no repeats. */
function checkAlarms(alarms: number[]): number[] {
  if (!alarms.every((m) => Number.isInteger(m) && Math.abs(m) <= 525_600)) throw new Error('A reminder is a whole number of minutes before the due')
  return [...new Set(alarms)]
}

/** Creates or updates a task; `links` are added (existing links stay), `labelIds` replaces the labels. */
export function saveTask(db: MailDatabase, input: TaskInput): Task {
  const id = db.transaction(() => {
    const at = Date.now()
    const existing = input.id ? (db.query('SELECT * FROM tasks WHERE id = ?').get(input.id) as TaskRow | null) : null
    if (input.id && !existing) throw new Error('Task not found')
    const title = (input.title ?? existing?.title ?? '').replace(/\s+/g, ' ').trim()
    if (!title) throw new Error('A task needs a title')
    if (input.origin && !ORIGINS.includes(input.origin)) throw new Error(`Unknown task origin “${input.origin}”`)
    if (input.status && !TASK_STATUSES.includes(input.status)) throw new Error(`Unknown task status “${input.status}”`)
    const status = input.status ?? existing?.status ?? 'todo'
    const priority = checkPriority(input.priority ?? existing?.priority ?? 0)
    const projectId = input.projectId === undefined ? (existing?.project_id ?? null) : input.projectId
    if (projectId && !db.query('SELECT 1 FROM task_projects WHERE id = ?').get(projectId)) throw new Error('Project not found')
    const allDay = input.dueAllDay ?? (existing ? existing.due_all_day === 1 : false)
    const dueAt = snapDue(input.dueAt === undefined ? (existing?.due_at ?? null) : input.dueAt, allDay)
    const remindAt = input.remindAt === undefined ? (existing?.remind_at ?? null) : input.remindAt
    const notes = input.notes ?? existing?.notes ?? ''
    // A task's own reminders are minutes before a time, or before the day's midnight for a date-only
    // due, so they don't carry over when the due gains or loses its time ("30 minutes before" would
    // become 23:30 the day before) or goes: it follows the default again, as an event's does.
    const kindChanged = !!existing && existing.due_at !== null && (dueAt === null || (existing.due_all_day === 1) !== allDay)
    const alarms = input.alarms === undefined ? (kindChanged ? null : (existing?.alarms_json ?? null)) : input.alarms === null ? null : JSON.stringify(checkAlarms(input.alarms))
    // Closing stamps when; staying closed (done → canceled) keeps it; reopening clears it.
    const completedAt = !isClosed(status) ? null : existing && isClosed(existing.status) ? existing.completed_at : at
    const id = existing?.id ?? newId('task')
    if (existing) {
      db.run('UPDATE tasks SET title = ?, notes = ?, status = ?, priority = ?, project_id = ?, due_at = ?, due_all_day = ?, remind_at = ?, alarms_json = ?, completed_at = ?, updated_at = ? WHERE id = ?', [
        title, notes, status, priority, projectId, dueAt, dueAt === null ? 0 : allDay ? 1 : 0, remindAt, alarms, completedAt, at, id,
      ])
    } else {
      const number = taskNumber(db, input.number)
      db.run(
        'INSERT INTO tasks (id, uid, number, title, notes, status, priority, project_id, due_at, due_all_day, remind_at, alarms_json, origin, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, `${crypto.randomUUID()}@jefi`, number, title, notes, status, priority, projectId, dueAt, dueAt === null ? 0 : allDay ? 1 : 0, remindAt, alarms, input.origin ?? 'manual', completedAt, at, at],
      )
    }
    if (input.labelIds) {
      const labels = [...new Set(input.labelIds)]
      const known = db.query('SELECT id FROM task_labels WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(labels)) as Array<{ id: string }>
      if (known.length !== labels.length) throw new Error('Label not found')
      db.run('DELETE FROM task_label_links WHERE task_id = ?', [id])
      for (const label of labels) db.run('INSERT INTO task_label_links (task_id, label_id) VALUES (?, ?)', [id, label])
    }
    for (const target of input.links ?? []) linkTask(db, id, target)
    return id
  })()
  return getTask(db, id)!
}

/**
 * The number for a new task: one more than any given out before (deleted ones included), or
 * `wanted` when that's a number given out before and free again (Undo after a delete).
 */
function taskNumber(db: MailDatabase, wanted: number | undefined): number {
  const highest = (db.query('SELECT MAX(number) n FROM tasks').get() as { n: number | null }).n ?? 0
  const last = Math.max(highest, (db.query('SELECT last FROM task_numbers WHERE id = 1').get() as { last: number } | null)?.last ?? 0)
  const free = wanted !== undefined && Number.isInteger(wanted) && wanted > 0 && wanted <= last && !db.query('SELECT 1 FROM tasks WHERE number = ?').get(wanted)
  const number = free ? wanted : last + 1
  db.run('INSERT INTO task_numbers (id, last) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last = max(last, excluded.last)', [number])
  return number
}

/** Ticks a task off (done) or brings it back (todo); ticking a closed task again keeps when it closed. */
export function setTaskDone(db: MailDatabase, id: string, done: boolean): Task {
  const task = getTask(db, id)
  if (!task) throw new Error('Task not found')
  if (done === isClosed(task.status)) return task
  return saveTask(db, { id, status: done ? 'done' : 'todo' })
}

export function deleteTask(db: MailDatabase, id: string): boolean {
  return db.transaction(() => {
    db.run('DELETE FROM task_links WHERE task_id = ?', [id])
    db.run('DELETE FROM task_label_links WHERE task_id = ?', [id])
    return db.run('DELETE FROM tasks WHERE id = ?', [id]).changes > 0
  })()
}

/**
 * Links a task to mail, an event or a person, snapshotting the target as it is now. Linking the same
 * target again refreshes its snapshot instead of adding a second link.
 */
export function linkTask(db: MailDatabase, taskId: string, target: LinkTarget, snapshot: LinkSnapshot = {}): TaskLink {
  if (!db.query('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) throw new Error('Task not found')
  let columns: { accountId: string | null; ref: string; header: string | null; snapshot: LinkSnapshot }
  if (target.kind === 'event') {
    const event = db.query('SELECT title, start_at FROM events WHERE id = ?').get(target.eventId) as { title: string; start_at: number } | null
    if (!event) throw new Error('Event not found')
    columns = { accountId: null, ref: target.eventId, header: null, snapshot: { ...snapshot, title: event.title, date: event.start_at } }
  } else if (target.kind === 'contact') {
    const email = target.email.trim().toLowerCase()
    if (!email) throw new Error('A contact link needs an email address')
    columns = { accountId: null, ref: email, header: null, snapshot: { ...snapshot, email, ...(target.name ? { name: target.name } : {}) } }
  } else columns = mailLinkColumns(db, target, snapshot)
  const same = db.query('SELECT id FROM task_links WHERE task_id = ? AND kind = ? AND account_id IS ? AND target_ref = ?').get(taskId, target.kind, columns.accountId, columns.ref) as { id: string } | null
  const id = same?.id ?? newId('tlink')
  if (same) db.run('UPDATE task_links SET message_id_header = ?, snapshot_json = ? WHERE id = ?', [columns.header, JSON.stringify(columns.snapshot), id])
  else {
    db.run('INSERT INTO task_links (id, task_id, kind, account_id, target_ref, message_id_header, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id, taskId, target.kind, columns.accountId, columns.ref, columns.header, JSON.stringify(columns.snapshot), Date.now(),
    ])
  }
  return linksOf(db, [taskId]).get(taskId)!.find((l) => l.id === id)!
}

export function unlinkTask(db: MailDatabase, linkId: string): boolean {
  return db.run('DELETE FROM task_links WHERE id = ?', [linkId]).changes > 0
}

/** The task a link belongs to, so the engine can say which task changed. */
export const taskOfLink = (db: MailDatabase, linkId: string) => (db.query('SELECT task_id FROM task_links WHERE id = ?').get(linkId) as { task_id: string } | null)?.task_id ?? null

/** Tasks linked to a conversation or any of its messages: open ones first, in list order. */
export function tasksForThread(db: MailDatabase, accountId: string, threadId: string): Task[] {
  const rows = db
    .query(`SELECT DISTINCT t.* FROM task_links l JOIN tasks t ON t.id = l.task_id WHERE ${THREAD_MATCH} ORDER BY ${ALL_ORDER}`)
    .all(...threadMatchArgs(db, accountId, threadId)) as TaskRow[]
  return tasksOf(db, rows)
}

// --- Projects and labels --------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i
const cleanName = (name: string, what: string) => {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error(`A ${what} needs a name`)
  if (clean.length > 60) throw new Error(`Keep a ${what} name under 60 characters`)
  return clean
}
const cleanColor = (color: string) => {
  if (!HEX.test(color)) throw new Error('Pick a colour like #8B5CF6')
  return color.toUpperCase()
}

export function listTaskProjects(db: MailDatabase): TaskProject[] {
  return (db.query('SELECT id, name, color, created_at FROM task_projects ORDER BY name COLLATE NOCASE, created_at').all() as Array<{ id: string; name: string; color: string; created_at: number }>).map(
    (r) => ({ id: r.id, name: r.name, color: r.color, createdAt: r.created_at }),
  )
}

export function saveTaskProject(db: MailDatabase, input: { id?: string; name: string; color: string }): TaskProject {
  const name = cleanName(input.name, 'project')
  const color = cleanColor(input.color)
  if (input.id) {
    if (!db.run('UPDATE task_projects SET name = ?, color = ? WHERE id = ?', [name, color, input.id]).changes) throw new Error('Project not found')
    return listTaskProjects(db).find((p) => p.id === input.id)!
  }
  const id = newId('proj')
  db.run('INSERT INTO task_projects (id, name, color, created_at) VALUES (?, ?, ?, ?)', [id, name, color, Date.now()])
  return listTaskProjects(db).find((p) => p.id === id)!
}

/** Deletes a project; its tasks stay, without one. */
export function deleteTaskProject(db: MailDatabase, id: string): boolean {
  return db.transaction(() => {
    db.run('UPDATE tasks SET project_id = NULL WHERE project_id = ?', [id])
    return db.run('DELETE FROM task_projects WHERE id = ?', [id]).changes > 0
  })()
}

export function listTaskLabels(db: MailDatabase): TaskLabel[] {
  return db.query('SELECT id, name, color FROM task_labels ORDER BY name COLLATE NOCASE').all() as TaskLabel[]
}

export function saveTaskLabel(db: MailDatabase, input: { id?: string; name: string; color: string }): TaskLabel {
  const name = cleanName(input.name, 'label')
  const color = cleanColor(input.color)
  const clash = db.query('SELECT id FROM task_labels WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(name, input.id ?? null) as { id: string } | null
  if (clash) throw new Error(`There's already a label called “${name}”`)
  if (input.id) {
    if (!db.run('UPDATE task_labels SET name = ?, color = ? WHERE id = ?', [name, color, input.id]).changes) throw new Error('Label not found')
    return listTaskLabels(db).find((l) => l.id === input.id)!
  }
  const id = newId('label')
  db.run('INSERT INTO task_labels (id, name, color, created_at) VALUES (?, ?, ?, ?)', [id, name, color, Date.now()])
  return listTaskLabels(db).find((l) => l.id === id)!
}

/** Deletes a label and takes it off every task. */
export function deleteTaskLabel(db: MailDatabase, id: string): boolean {
  return db.transaction(() => {
    db.run('DELETE FROM task_label_links WHERE label_id = ?', [id])
    return db.run('DELETE FROM task_labels WHERE id = ?', [id]).changes > 0
  })()
}
