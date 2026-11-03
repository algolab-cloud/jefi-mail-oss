import { expect, test } from 'bun:test'
import type { Task } from '../engine'
import { TASKS_CALENDAR_ID, isTaskOccurrence, taskOccurrences, tasksCalendar } from './calendar'

const DAY = 86_400_000
const task = (over: Partial<Task>): Task => ({
  id: 'task-1', uid: 'u@jefi', number: 1, title: 'Task', notes: '', status: 'todo', priority: 0, projectId: null, labels: [],
  dueAt: null, dueAllDay: false, remindAt: null, alarms: null, origin: 'manual', completedAt: null, createdAt: 0, updatedAt: 0, links: [], ...over,
})

test('open tasks with a due become Tasks-calendar occurrences; others stay off the calendar', () => {
  const from = Date.UTC(2026, 8, 21)
  const to = from + 7 * DAY
  const occurrences = taskOccurrences(
    [
      task({ id: 'task-day', title: 'Pay rent', dueAt: Date.UTC(2026, 8, 25), dueAllDay: true }),
      task({ id: 'task-timed', title: 'Call Kenji', dueAt: Date.UTC(2026, 8, 23, 15), alarms: [30] }),
      task({ id: 'task-none', title: 'Someday' }),
      task({ id: 'task-done', status: 'done', dueAt: Date.UTC(2026, 8, 23) }),
      task({ id: 'task-canceled', status: 'canceled', dueAt: Date.UTC(2026, 8, 23) }),
      task({ id: 'task-later', dueAt: Date.UTC(2026, 9, 20), dueAllDay: true }),
    ],
    from,
    to,
  )
  expect(occurrences.map((o) => [o.key, o.calendarId, o.startAt, o.endAt, o.allDay])).toEqual([
    ['task:task-day', TASKS_CALENDAR_ID, Date.UTC(2026, 8, 25), Date.UTC(2026, 8, 26), true],
    ['task:task-timed', TASKS_CALENDAR_ID, Date.UTC(2026, 8, 23, 15), Date.UTC(2026, 8, 23, 15, 30), false],
  ])
  expect(occurrences[1]).toMatchObject({ id: 'task-timed', title: 'Call Kenji', recurring: false, alarms: [30] })
  expect(occurrences.every(isTaskOccurrence)).toBe(true)
  // Read-only, so the views don't offer to drag or edit them.
  expect(tasksCalendar('#8B5CF6')).toMatchObject({ id: TASKS_CALENDAR_ID, name: 'Tasks', canWrite: false, hidden: false })
})
