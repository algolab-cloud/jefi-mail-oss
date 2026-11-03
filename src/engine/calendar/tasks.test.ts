import { afterEach, expect, test } from 'bun:test'
import { openDatabase, type MailDatabase } from '../db'
import { deleteAccountData, ensureAccount } from '../mail-store'
import { saveEvent } from './store'
import { deleteTask, deleteTaskLabel, deleteTaskProject, getTask, linkTask, listTaskLabels, listTaskProjects, listTasks, saveTask, saveTaskLabel, saveTaskProject, setTaskDone, tasksForThread, unlinkTask } from './tasks'

const dbs: MailDatabase[] = []
afterEach(() => {
  while (dbs.length) dbs.pop()!.close()
})
const fresh = () => {
  const db = openDatabase(':memory:')
  dbs.push(db)
  return db
}

const DAY = 86_400_000

function mail(db: MailDatabase, accountId: string, n: number, thread: string | null = 't1') {
  ensureAccount(db, accountId, `${accountId}@example.com`)
  db.run("INSERT INTO messages (account_id, message_id, thread_id, subject, from_name, from_email, date) VALUES (?, ?, ?, ?, 'Ada', 'ada@example.com', ?)", [accountId, `<t${n}@example.com>`, thread, `Subject ${n}`, n])
  return (db.query('SELECT last_insert_rowid() id').get() as { id: number }).id
}

test('tasks: create, edit, complete, reopen and delete', () => {
  const db = fresh()
  const task = saveTask(db, { title: '  Send the   deck ', notes: 'Slides 3–5' })
  expect(task).toMatchObject({ number: 1, title: 'Send the deck', notes: 'Slides 3–5', status: 'todo', priority: 0, projectId: null, labels: [], dueAt: null, dueAllDay: false, origin: 'manual', completedAt: null, links: [] })
  expect(task.id).toStartWith('task-')
  expect(task.uid).toEndWith('@jefi')

  // Undefined fields keep their value; null clears the due date.
  const due = saveTask(db, { id: task.id, dueAt: 1_700_000_000_000, priority: 2 })
  expect(due).toMatchObject({ title: 'Send the deck', notes: 'Slides 3–5', dueAt: 1_700_000_000_000, priority: 2 })
  expect(saveTask(db, { id: task.id, dueAt: null }).dueAt).toBeNull()

  const done = setTaskDone(db, task.id, true)
  expect(done.status).toBe('done')
  expect(done.completedAt).toBeNumber()
  // Ticking it again keeps when it was done.
  expect(setTaskDone(db, task.id, true).completedAt).toBe(done.completedAt)
  expect(setTaskDone(db, task.id, false)).toMatchObject({ status: 'todo', completedAt: null })

  expect(deleteTask(db, task.id)).toBe(true)
  expect(deleteTask(db, task.id)).toBe(false)
  expect(getTask(db, task.id)).toBeNull()
})

test('tasks: refuse a blank title, an unknown task and an unknown origin', () => {
  const db = fresh()
  expect(() => saveTask(db, { title: '   ' })).toThrow('A task needs a title')
  expect(() => saveTask(db, { id: 'nope', title: 'x' })).toThrow('Task not found')
  expect(() => setTaskDone(db, 'nope', true)).toThrow('Task not found')
  expect(() => saveTask(db, { title: 'x', origin: 'robot' as never })).toThrow('Unknown task origin')
  expect(() => saveTask(db, { title: 'x', status: 'maybe' as never })).toThrow('Unknown task status')
  expect(() => saveTask(db, { title: 'x', priority: 7 as never })).toThrow('Priority is 0')
  expect(() => saveTask(db, { title: 'x', projectId: 'nope' })).toThrow('Project not found')
  expect(() => saveTask(db, { title: 'x', labelIds: ['nope'] })).toThrow('Label not found')
})

test('tasks: statuses close and reopen, numbers count up and are never reused', () => {
  const db = fresh()
  const a = saveTask(db, { title: 'A', status: 'backlog' })
  const b = saveTask(db, { title: 'B', status: 'in_progress' })
  expect([a.number, b.number]).toEqual([1, 2])
  const done = saveTask(db, { id: b.id, status: 'done' })
  expect(done.completedAt).toBeNumber()
  // Done to canceled stays closed and keeps when; back to in progress reopens.
  expect(saveTask(db, { id: b.id, status: 'canceled' }).completedAt).toBe(done.completedAt)
  expect(saveTask(db, { id: b.id, status: 'in_progress' }).completedAt).toBeNull()
  expect(saveTask(db, { title: 'C', status: 'canceled' }).completedAt).toBeNumber()
  deleteTask(db, a.id)
  deleteTask(db, b.id)
  expect(saveTask(db, { title: 'D' }).number).toBe(4)
  expect(listTasks(db, { status: ['canceled'] }).map((t) => t.title)).toEqual(['C'])
  expect(listTasks(db, { status: 'closed' }).map((t) => t.title)).toEqual(['C'])
})

test('tasks: deleting the newest task doesn’t hand its number on; Undo gets it back', () => {
  const db = fresh()
  const a = saveTask(db, { title: 'A' })
  const b = saveTask(db, { title: 'B' })
  expect(deleteTask(db, b.id)).toBe(true)
  expect(saveTask(db, { title: 'C' }).number).toBe(3)
  // Undo restores the old number while it's free; one in use, or never given out, isn't taken.
  expect(saveTask(db, { title: 'B', number: b.number }).number).toBe(2)
  expect(saveTask(db, { title: 'D', number: a.number }).number).toBe(4)
  expect(saveTask(db, { title: 'E', number: 99 }).number).toBe(5)
  // A build without the counter may have added tasks meanwhile: the counter never goes backwards.
  db.run('INSERT INTO tasks (id, uid, number, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['task-old', 'old@jefi', 9, 'Old build', 0, 0])
  expect(saveTask(db, { title: 'F' }).number).toBe(10)
})

test('projects and labels: named, coloured, filterable; deleting keeps the tasks', () => {
  const db = fresh()
  const launch = saveTaskProject(db, { name: '  Launch ', color: '#8b5cf6' })
  expect(launch).toMatchObject({ name: 'Launch', color: '#8B5CF6' })
  const bug = saveTaskLabel(db, { name: 'Bug', color: '#E5484D' })
  const docs = saveTaskLabel(db, { name: 'Docs', color: '#3E63DD' })
  expect(() => saveTaskLabel(db, { name: 'bug', color: '#000000' })).toThrow('already a label')
  expect(() => saveTaskProject(db, { name: ' ', color: '#000000' })).toThrow('needs a name')
  expect(() => saveTaskProject(db, { name: 'X', color: 'red' })).toThrow('Pick a colour')

  const task = saveTask(db, { title: 'Ship it', projectId: launch.id, labelIds: [docs.id, bug.id, bug.id] })
  expect(task.projectId).toBe(launch.id)
  expect(task.labels.map((l) => l.name)).toEqual(['Bug', 'Docs'])
  saveTask(db, { title: 'Other' })
  expect(listTasks(db, { projectId: launch.id }).map((t) => t.title)).toEqual(['Ship it'])
  expect(listTasks(db, { labelId: docs.id }).map((t) => t.title)).toEqual(['Ship it'])
  // labelIds replaces; leaving it out keeps them.
  expect(saveTask(db, { id: task.id, title: 'Ship it now' }).labels).toHaveLength(2)
  expect(saveTask(db, { id: task.id, labelIds: [docs.id] }).labels.map((l) => l.name)).toEqual(['Docs'])

  expect(saveTaskProject(db, { id: launch.id, name: 'Launch v2', color: '#000000' }).name).toBe('Launch v2')
  expect(deleteTaskProject(db, launch.id)).toBe(true)
  expect(deleteTaskLabel(db, docs.id)).toBe(true)
  expect(getTask(db, task.id)).toMatchObject({ title: 'Ship it now', projectId: null, labels: [] })
  expect(listTaskProjects(db)).toEqual([])
  expect(listTaskLabels(db).map((l) => l.name)).toEqual(['Bug'])
})

test('tasks: a date-only due snaps to its UTC midnight and clearing the due drops the flag', () => {
  const db = fresh()
  const task = saveTask(db, { title: 'Pay rent', dueAt: Date.UTC(2026, 9, 1, 15, 30), dueAllDay: true })
  expect(task).toMatchObject({ dueAt: Date.UTC(2026, 9, 1), dueAllDay: true })
  expect(saveTask(db, { id: task.id, dueAt: null })).toMatchObject({ dueAt: null, dueAllDay: false })
})

test('tasks list: open by due (none last), priority first, then newest; closed by completion', async () => {
  const db = fresh()
  const now = Date.UTC(2026, 8, 26)
  const later = saveTask(db, { title: 'Later', dueAt: now + 3 * DAY })
  const soon = saveTask(db, { title: 'Soon', dueAt: now + DAY })
  const someday = saveTask(db, { title: 'Someday' })
  await Bun.sleep(2)
  const newer = saveTask(db, { title: 'Newer someday' })
  const flagged = saveTask(db, { title: 'Urgent someday', priority: 1 })
  expect(listTasks(db).map((t) => t.title)).toEqual(['Soon', 'Later', 'Urgent someday', 'Newer someday', 'Someday'])

  setTaskDone(db, soon.id, true)
  await Bun.sleep(2)
  setTaskDone(db, someday.id, true)
  expect(listTasks(db).map((t) => t.title)).toEqual(['Later', 'Urgent someday', 'Newer someday'])
  expect(listTasks(db, { status: 'closed' }).map((t) => t.title)).toEqual(['Someday', 'Soon'])
  expect(listTasks(db, { status: 'all' }).map((t) => t.title)).toEqual(['Later', 'Urgent someday', 'Newer someday', 'Someday', 'Soon'])
  expect(listTasks(db, { status: 'closed', limit: 1 }).map((t) => t.title)).toEqual(['Someday'])
  void later
  void newer
  void flagged
})

test('tasks search: titles and notes, by word prefix, any input safe', () => {
  const db = fresh()
  saveTask(db, { title: 'Review pricing', notes: 'Churn chart' })
  const done = saveTask(db, { title: 'Book flights', notes: 'Lisbon, Thursday' })
  setTaskDone(db, done.id, true)
  const titles = (search: string, status: 'open' | 'closed' | 'all' = 'all') => listTasks(db, { search, status }).map((t) => t.title)
  expect(titles('pric')).toEqual(['Review pricing'])
  expect(titles('churn')).toEqual(['Review pricing'])
  expect(titles('lisbon')).toEqual(['Book flights'])
  expect(titles('lisbon', 'open')).toEqual([])
  expect(titles('"unbalanced AND (')).toEqual([])
  expect(titles('   ')).toEqual(['Review pricing', 'Book flights'])
})

test('task links: mail, events and people, with snapshots; the conversation finds its tasks', () => {
  const db = fresh()
  const first = mail(db, 'a', 1)
  const second = mail(db, 'a', 2)
  const task = saveTask(db, { title: 'Reply to Ada', origin: 'email', links: [{ kind: 'message', accountId: 'a', messageId: `a:t1-${second}` }] })
  expect(task.origin).toBe('email')
  expect(task.links).toHaveLength(1)
  expect(task.links[0]).toMatchObject({ taskId: task.id, live: true, snapshot: { subject: 'Subject 2', from: { name: 'Ada', email: 'ada@example.com' } } })

  const event = saveEvent(db, { title: 'Board dry run', startAt: 1_000, endAt: 2_000 })
  linkTask(db, task.id, { kind: 'event', eventId: event.id })
  linkTask(db, task.id, { kind: 'contact', email: ' Ada@Example.com ', name: 'Ada' })
  // Linking the same target again refreshes it rather than adding one.
  linkTask(db, task.id, { kind: 'message', accountId: 'a', messageId: `a:t1-${second}` })
  expect(getTask(db, task.id)!.links.map((l) => l.target.kind)).toEqual(['message', 'event', 'contact'])

  const other = saveTask(db, { title: 'Unrelated' })
  expect(tasksForThread(db, 'a', 'a:t1').map((t) => t.title)).toEqual(['Reply to Ada'])
  linkTask(db, other.id, { kind: 'thread', accountId: 'a', threadId: 'a:t1' })
  expect(tasksForThread(db, 'a', 'a:t1').map((t) => t.title).sort()).toEqual(['Reply to Ada', 'Unrelated'])
  void first

  const link = getTask(db, task.id)!.links[0]!
  expect(unlinkTask(db, link.id)).toBe(true)
  expect(unlinkTask(db, link.id)).toBe(false)
  expect(() => linkTask(db, 'nope', { kind: 'contact', email: 'x@example.com' })).toThrow('Task not found')
  expect(() => linkTask(db, task.id, { kind: 'event', eventId: 'nope' })).toThrow('Event not found')
})

test('removing an account keeps its tasks, with their mail links detached', () => {
  const db = fresh()
  const id = mail(db, 'gone', 1)
  const task = saveTask(db, { title: 'Follow up', links: [{ kind: 'message', accountId: 'gone', messageId: `gone:t1-${id}` }] })
  deleteAccountData(db, 'gone')
  const kept = getTask(db, task.id)!
  expect(kept.title).toBe('Follow up')
  expect(kept.links[0]).toMatchObject({ target: { kind: 'message', accountId: null }, live: false, snapshot: { subject: 'Subject 1' } })
})

test('task reminders: null follows the default, [] is none, minutes are whole and unique', () => {
  const db = fresh()
  const task = saveTask(db, { title: 'Call Kenji', dueAt: 1_000_000, alarms: [30, 30, 60] })
  expect(task.alarms).toEqual([30, 60])
  expect(saveTask(db, { id: task.id, title: 'Call Kenji back' }).alarms).toEqual([30, 60])
  expect(saveTask(db, { id: task.id, alarms: [] }).alarms).toEqual([])
  expect(saveTask(db, { id: task.id, alarms: null }).alarms).toBeNull()
  expect(() => saveTask(db, { id: task.id, alarms: [1.5] })).toThrow('whole number of minutes')
})

test('task reminders follow the default again when the due gains or loses its time, or goes', () => {
  const db = fresh()
  const task = saveTask(db, { title: 'Call Kenji', dueAt: Date.UTC(2026, 9, 2, 13), alarms: [30] })
  // Another time the same day, or another day: still 30 minutes before.
  expect(saveTask(db, { id: task.id, dueAt: Date.UTC(2026, 9, 3, 15) }).alarms).toEqual([30])
  // Without its time, "30 minutes before" would be 23:30 the day before.
  expect(saveTask(db, { id: task.id, dueAt: Date.UTC(2026, 9, 3), dueAllDay: true }).alarms).toBeNull()
  expect(saveTask(db, { id: task.id, alarms: [900] }).alarms).toEqual([900])
  expect(saveTask(db, { id: task.id, dueAt: Date.UTC(2026, 9, 4), dueAllDay: true }).alarms).toEqual([900])
  expect(saveTask(db, { id: task.id, dueAt: Date.UTC(2026, 9, 4, 9), dueAllDay: false }).alarms).toBeNull()
  expect(saveTask(db, { id: task.id, alarms: [] }).alarms).toEqual([])
  expect(saveTask(db, { id: task.id, dueAt: null }).alarms).toBeNull()
  // Choosing reminders along with the new due keeps them.
  expect(saveTask(db, { id: task.id, dueAt: Date.UTC(2026, 9, 4), dueAllDay: true, alarms: [-540] }).alarms).toEqual([-540])
})
