import { expect, test } from 'bun:test'
import type { Message } from '../data'
import type { Task } from '../engine'
import { NO_FILTER, dueCount, dueShortcuts, dueText, filterTasks, groupBy, groupTasks, isOverdue, named, parseTaskText, quickAddInput, restorableTask, sortTasks, stepIndex, taskDraftFromMessage, taskKey, viewCount, viewLabel, viewPrefill, viewQuery, withDueDay } from './model'

/** Runs `fn` with the process in another time zone (Bun re-reads TZ when it changes). */
function inZone<T>(zone: string, fn: () => T): T {
  const before = process.env.TZ
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

const task = (over: Partial<Task> = {}): Task => ({
  id: over.id ?? 'task-1',
  uid: 'u@jefi',
  number: 1,
  title: 'A task',
  notes: '',
  status: 'todo',
  priority: 0,
  projectId: null,
  labels: [],
  dueAt: null,
  dueAllDay: false,
  remindAt: null,
  alarms: null,
  origin: 'manual',
  completedAt: null,
  createdAt: 0,
  updatedAt: 0,
  links: [],
  ...over,
})

// Saturday 26 September 2026, 10:00 in Berlin.
const NOW = Date.UTC(2026, 8, 26, 8)

test('quick add reads the due date out of the text and leaves the rest as the title', () => {
  inZone('Europe/Berlin', () => {
    expect(parseTaskText('Send the deck Friday 3pm', NOW, 'Europe/Berlin')).toEqual({ title: 'Send the deck', dueAt: Date.UTC(2026, 9, 2, 13), dueAllDay: false })
    expect(parseTaskText('Pay rent tomorrow', NOW, 'Europe/Berlin')).toEqual({ title: 'Pay rent', dueAt: Date.UTC(2026, 8, 27), dueAllDay: true })
    expect(parseTaskText('Review pricing by Oct 3', NOW, 'Europe/Berlin')).toEqual({ title: 'Review pricing', dueAt: Date.UTC(2026, 9, 3), dueAllDay: true })
    expect(parseTaskText('Renew passport in 2 weeks', NOW, 'Europe/Berlin')).toMatchObject({ title: 'Renew passport', dueAllDay: true })
    expect(parseTaskText('  Call   Kenji ', NOW, 'Europe/Berlin')).toEqual({ title: 'Call Kenji', dueAt: null, dueAllDay: false })
    // A date and nothing else keeps the text as the title.
    expect(parseTaskText('tomorrow', NOW, 'Europe/Berlin')).toMatchObject({ title: 'tomorrow', dueAllDay: true })
  })
})

test('quick add: today named after noon stays today, not a year or a week on', () => {
  inZone('Europe/Berlin', () => {
    // Saturday 26 September 2026, 15:00 and 23:50 in Berlin.
    for (const now of [Date.UTC(2026, 8, 26, 13), Date.UTC(2026, 8, 26, 21, 50)]) {
      expect(parseTaskText('Dentist Sep 26', now, 'Europe/Berlin')).toEqual({ title: 'Dentist', dueAt: Date.UTC(2026, 8, 26), dueAllDay: true })
      expect(parseTaskText('Dentist 9/26', now, 'Europe/Berlin')).toEqual({ title: 'Dentist', dueAt: Date.UTC(2026, 8, 26), dueAllDay: true })
      expect(parseTaskText('Call Saturday', now, 'Europe/Berlin')).toEqual({ title: 'Call', dueAt: Date.UTC(2026, 8, 26), dueAllDay: true })
      expect(parseTaskText('Review Sep 26 at 10am', now, 'Europe/Berlin')).toEqual({ title: 'Review', dueAt: Date.UTC(2026, 8, 26, 8), dueAllDay: false })
      // Other days still look ahead, and a bare time is the next one.
      expect(parseTaskText('Call Friday', now, 'Europe/Berlin')).toEqual({ title: 'Call', dueAt: Date.UTC(2026, 9, 2), dueAllDay: true })
      expect(parseTaskText('Call at 9am', now, 'Europe/Berlin')).toEqual({ title: 'Call', dueAt: Date.UTC(2026, 8, 27, 7), dueAllDay: false })
      expect(parseTaskText('Pay rent tomorrow', now, 'Europe/Berlin')).toEqual({ title: 'Pay rent', dueAt: Date.UTC(2026, 8, 27), dueAllDay: true })
    }
  })
})

test('groups: overdue, today, upcoming and no date, on the person’s clock', () => {
  inZone('America/Los_Angeles', () => {
    // Friday 25 September, 20:00 in Los Angeles (already Saturday in UTC).
    const now = Date.UTC(2026, 8, 26, 3)
    const tasks = [
      task({ id: 'yesterday', dueAt: Date.UTC(2026, 8, 24), dueAllDay: true }),
      task({ id: 'earlier-today', dueAt: Date.UTC(2026, 8, 25, 16) }),
      task({ id: 'today', dueAt: Date.UTC(2026, 8, 25), dueAllDay: true }),
      task({ id: 'tonight', dueAt: Date.UTC(2026, 8, 26, 5) }),
      task({ id: 'tomorrow', dueAt: Date.UTC(2026, 8, 26), dueAllDay: true }),
      task({ id: 'someday' }),
      task({ id: 'done', status: 'done', dueAt: Date.UTC(2026, 8, 20), dueAllDay: true }),
    ]
    expect(groupTasks(tasks, now).map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ['Overdue', ['yesterday', 'earlier-today']],
      ['Today', ['today', 'tonight']],
      ['Upcoming', ['tomorrow']],
      ['No date', ['someday']],
    ])
    expect(dueCount(tasks, now)).toBe(4)
    expect(isOverdue(tasks[6]!, now)).toBe(false)
  })
})

test('due text: relative days, weekdays within the week, then dates; timed ones add the time', () => {
  inZone('Europe/Berlin', () => {
    const day = (d: number) => task({ dueAt: Date.UTC(2026, 8, d), dueAllDay: true })
    expect(dueText(day(26), NOW, 'en-US')).toBe('Today')
    expect(dueText(day(27), NOW, 'en-US')).toBe('Tomorrow')
    expect(dueText(day(25), NOW, 'en-US')).toBe('Yesterday')
    expect(dueText(day(30), NOW, 'en-US')).toBe('Wednesday')
    expect(dueText(task({ dueAt: Date.UTC(2026, 9, 3), dueAllDay: true }), NOW, 'en-US')).toBe('Oct 3')
    expect(dueText(task({ dueAt: Date.UTC(2027, 0, 4), dueAllDay: true }), NOW, 'en-US')).toBe('Jan 4, 2027')
    expect(dueText(task({ dueAt: Date.UTC(2026, 8, 27, 13) }), NOW, 'en-US')).toBe('Tomorrow · 3:00 PM')
    expect(dueText(task(), NOW, 'en-US')).toBe('')
  })
})

test('picking a day keeps a timed due’s time and makes a date-only one otherwise', () => {
  inZone('Europe/Berlin', () => {
    const friday = new Date(2026, 9, 2).getTime()
    expect(withDueDay({ dueAt: null, dueAllDay: false }, friday)).toEqual({ dueAt: Date.UTC(2026, 9, 2), dueAllDay: true })
    expect(withDueDay({ dueAt: Date.UTC(2026, 8, 27, 13), dueAllDay: false }, friday)).toEqual({ dueAt: Date.UTC(2026, 9, 2, 13), dueAllDay: false })
    // Saturday: next week is Monday the 28th.
    expect(dueShortcuts(NOW).map((s) => [s.label, new Date(s.day).getDate()])).toEqual([['Today', 26], ['Tomorrow', 27], ['Next week', 28]])
  })
})

test('an email drafts a task from its subject and the next date it mentions', () => {
  inZone('Europe/Berlin', () => {
    const message = (text: string) => ({ id: 'm1', timestamp: NOW - 3_600_000, paragraphs: [text], text, sender: 'Lea', email: 'lea@atlas.dev' }) as unknown as Message
    expect(taskDraftFromMessage({ subject: 'Re: Fwd: Q3 review follow-ups' }, message('Could we do a dry run on Monday at 2pm?'), NOW, 'Europe/Berlin')).toEqual({
      title: 'Q3 review follow-ups',
      dueAt: Date.UTC(2026, 8, 28, 12),
      dueAllDay: false,
    })
    expect(taskDraftFromMessage({ subject: 'Hello' }, message('Nothing to schedule here.'), NOW, 'Europe/Berlin')).toEqual({ title: 'Hello', dueAt: null, dueAllDay: false })
  })
})

test('an email asking for something "by Friday" drafts a task due then', () => {
  inZone('Europe/Berlin', () => {
    const message = (text: string) => ({ id: 'm1', timestamp: NOW - 3_600_000, paragraphs: [text], text, sender: 'Lea', email: 'lea@atlas.dev' }) as unknown as Message
    const draft = (text: string) => taskDraftFromMessage({ subject: 'Pricing' }, message(text), NOW, 'Europe/Berlin')
    expect(draft('Could you send me the numbers by Friday?')).toEqual({ title: 'Pricing', dueAt: Date.UTC(2026, 9, 2), dueAllDay: true })
    expect(draft('The report is due on October 5.')).toMatchObject({ dueAt: Date.UTC(2026, 9, 5), dueAllDay: true })
    expect(draft('Please reply no later than Thursday 5pm.')).toMatchObject({ dueAt: Date.UTC(2026, 9, 1, 15), dueAllDay: false })
    // A bare time, a date that isn't a deadline, or one already past: no due.
    expect(draft('Can you get back to me by 5pm?')).toMatchObject({ dueAt: null })
    expect(draft('I was in Lisbon on Friday, lovely.')).toMatchObject({ dueAt: null })
    expect(draft('I sent it before September 1.')).toMatchObject({ dueAt: null })
    // Only the message's own words, not the quoted mail it answers.
    const reply = { ...message('Thanks, on it.'), paragraphs: ['Thanks, on it.', '> Could you send me the numbers by Friday?'] } as unknown as Message
    expect(taskDraftFromMessage({ subject: 'Pricing' }, reply, NOW, 'Europe/Berlin')).toMatchObject({ dueAt: null })
  })
})

test('undo after delete restores the task with its live links', () => {
  const restored = restorableTask(
    task({
      title: 'Reply',
      priority: 2,
      labels: [{ id: 'l1', name: 'Bug', color: '#E5484D' }],
      links: [
        { id: 'l1', taskId: 'task-1', target: { kind: 'thread', accountId: 'a', threadId: 'a:t' }, snapshot: {}, live: true, createdAt: 0 },
        { id: 'l2', taskId: 'task-1', target: { kind: 'message', accountId: null }, snapshot: {}, live: false, createdAt: 0 },
      ],
    }),
  )
  expect(restored).toMatchObject({ title: 'Reply', priority: 2, status: 'todo', number: 1, labelIds: ['l1'], links: [{ kind: 'thread', accountId: 'a', threadId: 'a:t' }] })
})

test('display: group by status, under way first (a board keeps workflow order and empty columns), ordered by priority', () => {
  const tasks = [
    task({ id: 'low', status: 'todo', priority: 4 }),
    task({ id: 'urgent', status: 'todo', priority: 1 }),
    task({ id: 'none', status: 'todo', priority: 0 }),
    task({ id: 'doing', status: 'in_progress', priority: 3 }),
    task({ id: 'shipped', status: 'done' }),
  ]
  const context = { now: NOW, projects: [] }
  expect(groupBy(tasks, 'status', 'priority', context).map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
    ['In Progress', ['doing']],
    ['Todo', ['urgent', 'low', 'none']],
    ['Done', ['shipped']],
  ])
  expect(groupBy(tasks, 'status', 'priority', { ...context, empty: true }).map((g) => g.key)).toEqual(['backlog', 'todo', 'in_progress', 'done', 'canceled'])
  // A group's + makes a task in that group.
  expect(groupBy(tasks, 'priority', 'created', context).map((g) => [g.label, g.prefill])).toEqual([
    ['Urgent', { priority: 1 }],
    ['Medium', { priority: 3 }],
    ['Low', { priority: 4 }],
    ['No priority', { priority: 0 }],
  ])
  expect(groupBy(tasks, 'none', 'priority', context)).toHaveLength(1)
  expect(groupBy([], 'none', 'priority', context)).toEqual([])
})

test('display: projects by name then none; due groups end with the closed ones', () => {
  const projects = [{ id: 'p2', name: 'Website', color: '#3E63DD', createdAt: 0 }, { id: 'p1', name: 'Launch', color: '#8B5CF6', createdAt: 0 }]
  const tasks = [task({ id: 'a', projectId: 'p2' }), task({ id: 'b', projectId: 'p1' }), task({ id: 'c' }), task({ id: 'd', projectId: 'gone' }), task({ id: 'e', status: 'canceled' })]
  expect(groupBy(tasks, 'project', 'created', { now: NOW, projects }).map((g) => [g.label, g.tasks.map((t) => t.id).sort()])).toEqual([
    ['Launch', ['b']],
    ['Website', ['a']],
    ['No project', ['c', 'd', 'e']],
  ])
  inZone('Europe/Berlin', () => {
    const due = groupBy([task({ id: 'x', dueAt: Date.UTC(2026, 8, 26), dueAllDay: true }), task({ id: 'y' }), task({ id: 'z', status: 'done' })], 'due', 'priority', { now: NOW, projects })
    expect(due.map((g) => g.label)).toEqual(['Today', 'No date', 'Completed'])
  })
})

test('ordering and filters', () => {
  const a = task({ id: 'a', priority: 3, createdAt: 1, updatedAt: 9, dueAt: 50, labels: [{ id: 'bug', name: 'Bug', color: '#000000' }] })
  const b = task({ id: 'b', priority: 1, createdAt: 2, updatedAt: 1, projectId: 'p' })
  const c = task({ id: 'c', priority: 0, createdAt: 3, updatedAt: 5, dueAt: 10 })
  expect(sortTasks([a, b, c], 'priority').map((t) => t.id)).toEqual(['b', 'a', 'c'])
  expect(sortTasks([a, b, c], 'due').map((t) => t.id)).toEqual(['c', 'a', 'b'])
  expect(sortTasks([a, b, c], 'created').map((t) => t.id)).toEqual(['c', 'b', 'a'])
  expect(sortTasks([a, b, c], 'updated').map((t) => t.id)).toEqual(['a', 'c', 'b'])
  expect(filterTasks([a, b, c], NO_FILTER)).toHaveLength(3)
  expect(filterTasks([a, b, c], { ...NO_FILTER, labelIds: ['bug'] }).map((t) => t.id)).toEqual(['a'])
  expect(filterTasks([a, b, c], { ...NO_FILTER, projectIds: ['p'] }).map((t) => t.id)).toEqual(['b'])
  expect(filterTasks([a, b, c], { ...NO_FILTER, priorities: [0, 3] }).map((t) => t.id)).toEqual(['a', 'c'])
  expect(taskKey({ number: 12 })).toBe('T-12')
})

test('views: what each asks the engine for, and today/upcoming on the person’s clock', () => {
  inZone('Europe/Berlin', () => {
    expect(viewQuery('active', NOW).query).toEqual({ status: ['todo', 'in_progress'] })
    expect(viewQuery('backlog', NOW).query).toEqual({ status: ['backlog'] })
    expect(viewQuery('done', NOW).query).toMatchObject({ status: 'closed' })
    expect(viewQuery('project:p1', NOW).query).toEqual({ status: 'all', projectId: 'p1' })
    expect(viewQuery('label:l1', NOW).query).toEqual({ status: 'all', labelId: 'l1' })
    const today = viewQuery('today', NOW).keep!
    const upcoming = viewQuery('upcoming', NOW).keep!
    const yesterday = task({ dueAt: Date.UTC(2026, 8, 25), dueAllDay: true })
    const tomorrow = task({ dueAt: Date.UTC(2026, 8, 27), dueAllDay: true })
    expect([today(yesterday), today(tomorrow), today(task())]).toEqual([true, false, false])
    expect([upcoming(yesterday), upcoming(tomorrow)]).toEqual([false, true])
    expect(viewLabel('project:p1', [{ id: 'p1', name: 'Launch', color: '#000000', createdAt: 0 }], [])).toBe('Launch')
    expect(viewLabel('today', [], [])).toBe('Today')
  })
})

test('a task made in a view lands in it: Today and Upcoming give it a due unless one is typed', () => {
  inZone('Europe/Berlin', () => {
    expect(viewPrefill('today', NOW)).toEqual({ dueAt: Date.UTC(2026, 8, 26), dueAllDay: true })
    expect(viewPrefill('upcoming', NOW)).toEqual({ dueAt: Date.UTC(2026, 8, 27), dueAllDay: true })
    expect(viewPrefill('backlog', NOW)).toEqual({ status: 'backlog' })
    expect(viewPrefill('project:p1', NOW)).toEqual({ projectId: 'p1' })
    expect(viewPrefill('active', NOW)).toEqual({})

    const today = quickAddInput('Buy milk', 'today', NOW, 'Europe/Berlin')
    expect(today).toMatchObject({ title: 'Buy milk', dueAt: Date.UTC(2026, 8, 26), dueAllDay: true, origin: 'manual' })
    expect(viewQuery('today', NOW).keep!(task(today as Partial<Task>))).toBe(true)
    // A typed date wins over the view's.
    expect(quickAddInput('Buy milk Friday 3pm', 'today', NOW, 'Europe/Berlin')).toMatchObject({ title: 'Buy milk', dueAt: Date.UTC(2026, 9, 2, 13), dueAllDay: false })
    expect(quickAddInput('Buy milk', 'upcoming', NOW, 'Europe/Berlin')).toMatchObject({ dueAt: Date.UTC(2026, 8, 27), dueAllDay: true })
    expect(quickAddInput('Buy milk', 'all', NOW, 'Europe/Berlin')).toMatchObject({ title: 'Buy milk', dueAt: null, dueAllDay: false })
    expect(quickAddInput('Fix login', 'label:l1', NOW, 'Europe/Berlin')).toMatchObject({ labelIds: ['l1'], dueAt: null })
  })
})

test('Enter in the label or project menu picks the one named, ignoring case and spaces', () => {
  const labels = [{ id: 'l1', name: 'Bug' }, { id: 'l2', name: 'Needs design' }]
  expect(named(labels, '  bug ')?.id).toBe('l1')
  expect(named(labels, 'needs   Design')?.id).toBe('l2')
  expect(named(labels, 'Bugs')).toBeUndefined()
  expect(named(labels, '   ')).toBeUndefined()
})

test('J/K step on from where the open task was once it leaves the list', () => {
  // In the list: move by one, clamped at the ends.
  expect(stepIndex(5, 2, 1)).toBe(3)
  expect(stepIndex(5, 2, -1)).toBe(1)
  expect(stepIndex(5, 4, 1)).toBe(4)
  expect(stepIndex(5, 0, -1)).toBe(0)
  // Nothing current and nothing remembered: the top.
  expect(stepIndex(5, -1, 1)).toBe(0)
  expect(stepIndex(0, -1, 1)).toBe(-1)
  // Row 2 was completed with its sheet open (the list lost it): J lands on the old row 3 (now 2),
  // K on row 1, not on the first task.
  expect(stepIndex(4, -1, 1, 2)).toBe(2)
  expect(stepIndex(4, -1, -1, 2)).toBe(1)
  // It was the last row: J stays on the new last one; it was the first: K stays on the first.
  expect(stepIndex(4, -1, 1, 4)).toBe(3)
  expect(stepIndex(4, -1, -1, 0)).toBe(0)
})

test('a view counts its open tasks, as the sidebar does; Completed counts what it lists', () => {
  const tasks = [task({ id: 'a', status: 'todo' }), task({ id: 'b', status: 'in_progress' }), task({ id: 'c', status: 'done' }), task({ id: 'd', status: 'canceled' }), task({ id: 'e', status: 'backlog' })]
  expect(viewCount('project:p1', tasks)).toBe(3)
  expect(viewCount('label:l1', tasks)).toBe(3)
  expect(viewCount('active', tasks.slice(0, 2))).toBe(2)
  expect(viewCount('done', tasks.slice(2, 4))).toBe(2)
})
