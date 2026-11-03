import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkerEngine } from '../worker-client'
import type { EngineEvent } from '../types'

// The calendar and notes API through the engine worker, as the app runs it: arguments and results
// cross postMessage, errors come back as rejections, and change events arrive batched.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

test('calendar, notes and tasks calls round-trip through the worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jefi-calendar-worker-'))
  // The worker's own environment, so it opens a mail.db of its own and never the real one (HOME too,
  // in case the config dir were ever ignored).
  const engine = createWorkerEngine({ env: { ...process.env, JEFI_CONFIG_DIR: dir, HOME: dir } as Record<string, string> })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => engine.dispose())
  const events: EngineEvent[] = []
  engine.subscribe((batch) => events.push(...batch))

  const [calendar] = await engine.listCalendars()
  expect(existsSync(join(dir, 'mail.db'))).toBe(true)
  expect(calendar).toMatchObject({ name: 'Personal', source: 'local', isDefault: true })
  const work = await engine.createLocalCalendar({ name: 'Work', color: '#f60' })
  const series = await engine.saveEvent({ calendarId: work.id, title: 'Standup', startAt: Date.UTC(2026, 0, 5, 9), endAt: Date.UTC(2026, 0, 5, 9, 15), timeZone: 'UTC', recurrence: 'FREQ=WEEKLY;BYDAY=MO,TH;COUNT=3' })
  const listed = await engine.listEvents(Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1))
  expect(listed.map((o) => [o.key, o.calendarId, o.recurring])).toEqual([Date.UTC(2026, 0, 5, 9), Date.UTC(2026, 0, 8, 9), Date.UTC(2026, 0, 12, 9)].map((t) => [`${series.id}@${t}`, work.id, true]))
  expect(await engine.deleteEvent(series.id, 'this', Date.UTC(2026, 0, 8, 9))).toBe(true)
  expect((await engine.listEvents(Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1))).length).toBe(2)
  // Not expect().rejects: under bun test that never settled for a rejection coming back from the worker.
  const failed = await engine.saveEvent({ title: 'Bad', startAt: 2, endAt: 1 }).then(() => null, (err: Error) => err.message)
  expect(failed).toBe('An event can’t end before it starts')

  const note = await engine.saveNote({ title: 'Agenda', body: '1. Budget', links: [{ kind: 'event', eventId: series.id }, { kind: 'contact', email: 'ada@example.com' }] })
  expect((await engine.listNotes('budget')).map((n) => n.id)).toEqual([note.id])
  expect((await engine.notesForEvent(series.id)).map((n) => n.links.length)).toEqual([2])
  expect(await engine.getNote('missing')).toBeNull()
  const task = await engine.saveTask({ title: 'Book the room', dueAt: Date.UTC(2026, 0, 5), dueAllDay: true, links: [{ kind: 'event', eventId: series.id }] })
  expect((await engine.listTasks({ search: 'room' })).map((t) => [t.id, t.links.length])).toEqual([[task.id, 1]])
  expect((await engine.setTaskDone(task.id, true)).status).toBe('done')
  expect(await engine.getTask('missing')).toBeNull()
  const refused = await engine.saveTask({ title: '' }).then(() => null, (err: Error) => err.message)
  expect(refused).toBe('A task needs a title')
  // Events made here aren't invitations.
  expect(await engine.pendingInvites(Date.UTC(2026, 0, 1))).toEqual([])

  const started = Date.now()
  while (!events.some((e) => e.type === 'notesChanged') || events.filter((e) => e.type === 'tasksChanged').length < 2) {
    if (Date.now() - started > 5_000) throw new Error('no notesChanged event')
    await Bun.sleep(10)
  }
  expect(events.filter((e) => e.type === 'calendarChanged')).toEqual([
    { type: 'calendarChanged', calendarIds: [work.id] },
    { type: 'calendarChanged', calendarIds: [work.id] },
    { type: 'calendarChanged', calendarIds: [work.id] },
  ])
  expect(events.filter((e) => e.type === 'notesChanged')).toEqual([{ type: 'notesChanged', noteIds: [note.id] }])
  expect(events.filter((e) => e.type === 'tasksChanged')).toEqual([0, 1].map(() => ({ type: 'tasksChanged', taskIds: [task.id] })))
})

test('the worker fires a reminder on its own timer, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jefi-reminder-worker-'))
  const engine = createWorkerEngine({ env: { ...process.env, JEFI_CONFIG_DIR: dir, HOME: dir } as Record<string, string> })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => engine.dispose())
  const due: EngineEvent[] = []
  engine.subscribe((batch) => due.push(...batch.filter((e) => e.type === 'reminderDue')))
  // Ten minutes and a bit away with a ten-minute alert: due in about a second of real time.
  const startAt = Date.now() + 10 * 60_000 + 1_000
  const event = await engine.saveEvent({ title: 'Board dry run', location: 'Boardroom', startAt, endAt: startAt + 3_600_000, timeZone: 'UTC', alarms: [10] })
  engine.setReminderDefaults({ timed: [], allDay: [] })
  const started = Date.now()
  while (!due.length) {
    if (Date.now() - started > 5_000) throw new Error('no reminderDue event')
    await Bun.sleep(20)
  }
  await Bun.sleep(300)
  expect(due).toEqual([{ type: 'reminderDue', reminder: expect.objectContaining({ eventId: event.id, occurrenceStart: startAt, title: 'Board dry run', location: 'Boardroom', minutesBefore: 10 }) }])
})
