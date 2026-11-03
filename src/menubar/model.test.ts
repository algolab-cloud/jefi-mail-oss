import { describe, expect, test } from 'bun:test'
import { buildMenuBarModel, menuBarTitle, modelRange, parsePanelMessage, quickAddPrefill, quickAddTask, untilText } from './model'

const MIN = 60_000
const now = new Date(2026, 8, 26, 10, 0).getTime()
const at = (h: number, m = 0, day = 26) => new Date(2026, 8, day, h, m).getTime()
const occ = (key: string, start: number, end: number, extra: { allDay?: boolean; title?: string } = {}) => ({ key, title: extra.title ?? key, startAt: start, endAt: end, allDay: !!extra.allDay, calendarId: 'c1' })

describe('buildMenuBarModel', () => {
  const model = buildMenuBarModel({
    now,
    unread: 4,
    colorOf: () => '#3E63DD',
    firstDay: 1,
    occurrences: [
      occ('past', at(8), at(9)),
      occ('standup', at(10, 25), at(10, 40)),
      occ('birthday', Date.UTC(2026, 8, 26), Date.UTC(2026, 8, 27), { allDay: true }),
      occ('later', at(9, 0, 29), at(10, 0, 29)),
    ],
  })
  test('up next is the next timed event that has not ended', () => expect(model.upNext?.key).toBe('standup'))
  test('today lists all-day first, then by time', () => expect(model.today.map((e) => e.key)).toEqual(['birthday', 'past', 'standup']))
  test('the month grid marks today and busy days', () => {
    expect(model.month.days).toHaveLength(42)
    expect(model.month.days.find((d) => d.today)?.date).toBe(new Date(2026, 8, 26).getTime())
    expect(model.month.days.find((d) => d.date === new Date(2026, 8, 29).getTime())?.busy).toBe(true)
    expect(model.month.days.find((d) => d.date === new Date(2026, 8, 28).getTime())?.busy).toBe(false)
  })
  test('feeds default to empty', () => {
    expect(model.recent).toEqual([])
    expect(model.pendingInvites).toEqual([])
  })
  test('the range covers the grid and a week ahead', () => {
    const range = modelRange(new Date(2026, 8, 30).getTime(), 1)
    expect(range.to).toBeGreaterThanOrEqual(new Date(2026, 9, 8).getTime())
  })
})

describe('untilText', () => {
  test('counts down and reports what is on', () => {
    expect(untilText(now + 25 * MIN, now + 40 * MIN, now)).toBe('in 25m')
    expect(untilText(now + 125 * MIN, now + 140 * MIN, now)).toBe('in 2h 5m')
    expect(untilText(now + 3 * 24 * 60 * MIN, now + 3 * 24 * 60 * MIN + MIN, now)).toBe('in 3d')
    expect(untilText(now - 5 * MIN, now + 10 * MIN, now)).toBe('ends in 10m')
  })
})

describe('menuBarTitle', () => {
  const events = [{ title: 'Standup', start: now + 25 * MIN, end: now + 40 * MIN, allDay: false }]
  test('unread shows the count, nothing at zero', () => {
    expect(menuBarTitle({ mode: 'unread', unread: 12, events, now })).toBe('12')
    expect(menuBarTitle({ mode: 'unread', unread: 0, events, now })).toBe('')
    expect(menuBarTitle({ mode: 'unread', unread: 5000, events, now })).toBe('999+')
  })
  test('none is always empty', () => expect(menuBarTitle({ mode: 'none', unread: 3, events, now })).toBe(''))
  test('next event within the hour, short', () => {
    expect(menuBarTitle({ mode: 'next', unread: 3, events, now })).toBe('Standup in 25m')
    expect(menuBarTitle({ mode: 'next', unread: 3, events, now: now - 60 * MIN })).toBe('')
    expect(menuBarTitle({ mode: 'next', unread: 3, events, now: now + 27 * MIN })).toBe('Standup now')
    const long = menuBarTitle({ mode: 'next', unread: 0, events: [{ ...events[0]!, title: 'Quarterly board dry run with everyone' }], now })
    expect(long).toBe('Quarterly boa… in 25m')
  })
})

describe('parsePanelMessage', () => {
  test('accepts known actions only', () => {
    expect(parsePanelMessage('{"type":"compose"}')).toEqual({ type: 'compose', arg: '' })
    expect(parsePanelMessage('{"type":"open-day","arg":"123"}')).toEqual({ type: 'open-day', arg: '123' })
    expect(parsePanelMessage('{"type":"eval","arg":"x"}')).toBeNull()
    expect(parsePanelMessage('{"type":"compose","arg":5}')).toBeNull()
    expect(parsePanelMessage('not json')).toBeNull()
  })
})

describe('quickAddPrefill', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  test('splits the title from the date', () => {
    const p = quickAddPrefill('Lunch with Nora Friday 1pm', now, zone)
    expect(p.title).toBe('Lunch with Nora')
    expect(new Date(p.start!).getDay()).toBe(5)
    expect(new Date(p.start!).getHours()).toBe(13)
    expect(p.allDay).toBe(false)
  })
  test('drops a dangling preposition', () => expect(quickAddPrefill('Standup on Monday at 9', now, zone).title).toBe('Standup'))
  test('no date still opens the editor with the text', () => expect(quickAddPrefill('Call mom', now, zone)).toEqual({ title: 'Call mom' }))
})

describe('tasks in the menu bar', () => {
  const task = (n: number) => ({ id: `t${n}`, title: `Task ${n}`, due: 'Today', overdue: n === 0 })
  test('the panel lists a few tasks and counts the rest', () => {
    const model = buildMenuBarModel({ now, unread: 0, colorOf: () => '#000000', firstDay: 1, occurrences: [], tasks: [0, 1, 2, 3, 4, 5].map(task) })
    expect(model.tasks.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't3'])
    expect(model.tasksMore).toBe(2)
    expect(buildMenuBarModel({ now, unread: 0, colorOf: () => '#000000', firstDay: 1, occurrences: [] })).toMatchObject({ tasks: [], tasksMore: 0 })
  })
  test('quick add makes a task only after an explicit “Task:”', () => {
    expect(quickAddTask('Task: Send the deck Friday')).toBe('Send the deck Friday')
    expect(quickAddTask('todo - renew passport')).toBe('renew passport')
    expect(quickAddTask('  TO-DO:call Kenji')).toBe('call Kenji')
    expect(quickAddTask('Task force sync Friday 2pm')).toBeNull()
    // The prefix alone is still a task, one with nothing written yet (not an event titled "Task:").
    expect(quickAddTask('Task:   ')).toBe('')
    expect(quickAddTask('todo:')).toBe('')
    expect(quickAddTask('Lunch with Nora Friday 1pm')).toBeNull()
  })
  test('the panel may tick off and open tasks', () => {
    expect(parsePanelMessage(JSON.stringify({ type: 'toggle-task', arg: 'task-1' }))).toEqual({ type: 'toggle-task', arg: 'task-1' })
    expect(parsePanelMessage(JSON.stringify({ type: 'new-task' }))).toEqual({ type: 'new-task', arg: '' })
  })
})

describe('sign-in codes', () => {
  test('codes from the last quarter hour are listed newest first; older ones and plain mail are not', () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime()
    const mail = (id: string, minutesAgo: number, code?: string) => ({
      id,
      kind: 'mail' as const,
      title: `Sender ${id}`,
      detail: 'Subject',
      at: now - minutesAgo * 60_000,
      route: { type: 'thread' as const, accountId: 'a', threadId: id },
      ...(code ? { code } : {}),
    })
    const model = buildMenuBarModel({
      now,
      unread: 0,
      colorOf: () => '#000000',
      firstDay: 1,
      occurrences: [],
      recent: [mail('old', 20, '111111'), mail('plain', 1), mail('a', 5, '222222'), mail('b', 2, '333333')],
    })
    expect(model.codes.map((c) => c.code)).toEqual(['333333', '222222'])
  })

  test('copying a code is a panel action', () => {
    expect(parsePanelMessage(JSON.stringify({ type: 'copy-code', arg: 'mail:a' }))).toMatchObject({ type: 'copy-code', arg: 'mail:a' })
  })
})
