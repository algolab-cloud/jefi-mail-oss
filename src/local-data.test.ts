import { expect, test } from 'bun:test'
import type { Calendar, InviteSummary } from './engine'
import { applyLocalEvent, createLocalData, type LocalData } from './local-data'
import { clearRecent, recentNotifications } from './menubar-data'

const calendar = (name: string): Calendar => ({ id: name, source: 'local', name, color: '#000', canWrite: true, isDefault: false, hidden: false, url: null, createdAt: 1, updatedAt: 1 })

function fakeEngine() {
  let answer = [calendar('Personal')]
  let invites: InviteSummary[] = []
  const pending: Array<() => void> = []
  const engine = {
    listCalendars: () => {
      const snapshot = answer
      return new Promise<Calendar[]>((resolve) => pending.push(() => resolve(snapshot)))
    },
    listEvents: async () => [],
    listNotes: async () => [],
    notesForThread: async () => [],
    eventsForThread: async () => [],
    notesForEvent: async () => [],
    pendingInvites: async () => invites,
    listTasks: async () => [],
    tasksForThread: async () => [],
    listTaskProjects: async () => [],
    listTaskLabels: async () => [],
  } satisfies LocalData['engine']
  return { engine, setAnswer: (next: Calendar[]) => (answer = next), setInvites: (next: InviteSummary[]) => (invites = next), settle: async () => {
    while (pending.length) pending.shift()!()
    await Bun.sleep(0)
  } }
}

test('calendar, notes and tasks events bump their own revision and tell only local-data listeners', async () => {
  const fake = fakeEngine()
  const data = createLocalData(fake.engine)
  let heard = 0
  data.listeners.add(() => heard++)
  await fake.settle()
  expect(data.calendars.map((c) => c.name)).toEqual(['Personal'])

  fake.setAnswer([calendar('Personal'), calendar('Work')])
  expect(applyLocalEvent(data, { type: 'calendarChanged', calendarIds: ['Work'] })).toBe(true)
  expect([data.calendarRev, data.notesRev]).toEqual([1, 0])
  await fake.settle()
  expect(data.calendars.map((c) => c.name)).toEqual(['Personal', 'Work'])

  expect(applyLocalEvent(data, { type: 'notesChanged', noteIds: ['n'] })).toBe(true)
  expect([data.calendarRev, data.notesRev, data.tasksRev]).toEqual([1, 1, 0])
  expect(applyLocalEvent(data, { type: 'tasksChanged', taskIds: ['t'] })).toBe(true)
  expect([data.calendarRev, data.notesRev, data.tasksRev]).toEqual([1, 1, 1])
  expect(applyLocalEvent(data, { type: 'labelsChanged', accountId: 'a', labels: [] })).toBe(false)
  // Two calendar lists, two pending-invite lists, and the calendar, notes and tasks bumps.
  expect(heard).toBe(7)
})

test('a calendar list answered before a later change is dropped for the later one', async () => {
  const fake = fakeEngine()
  const data = createLocalData(fake.engine)
  applyLocalEvent(data, { type: 'calendarChanged' })
  fake.setAnswer([calendar('Newer')])
  applyLocalEvent(data, { type: 'calendarChanged' })
  await fake.settle()
  expect(data.calendars.map((c) => c.name)).toEqual(['Newer'])
})

const invite = (eventId: string, title: string): InviteSummary => ({
  eventId,
  title,
  startAt: Date.UTC(2026, 9, 5, 14),
  endAt: Date.UTC(2026, 9, 5, 15),
  allDay: false,
  timeZone: 'UTC',
  location: null,
  organizer: { email: 'boss@org.example', name: 'Boss' },
  accountId: 'acct',
  threadId: 'acct:t1',
  messageId: 'acct:t1-1',
  recurring: false,
})

test('pending invites refresh on calendarChanged; ones that newly arrive go on the recent list', async () => {
  clearRecent()
  const fake = fakeEngine()
  fake.setInvites([invite('e1', 'Kickoff')])
  const data = createLocalData(fake.engine)
  await fake.settle()
  // The first load is what was already waiting, not news.
  expect(data.pendingInvites!.map((i) => i.eventId)).toEqual(['e1'])
  expect(recentNotifications().items).toEqual([])

  fake.setInvites([invite('e1', 'Kickoff'), invite('e2', 'Review')])
  applyLocalEvent(data, { type: 'calendarChanged', calendarIds: ['local'] })
  await fake.settle()
  expect(data.pendingInvites!.map((i) => i.eventId)).toEqual(['e1', 'e2'])
  expect(recentNotifications().items).toMatchObject([{ id: 'invite:e2', kind: 'invite', title: 'Review', route: { accountId: 'acct', threadId: 'acct:t1' } }])
  expect(recentNotifications().items[0]!.subtitle).toStartWith('Invitation from Boss · ')
  clearRecent()
})
