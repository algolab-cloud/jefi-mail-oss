import { useMemo } from 'react'
import { dayLine, timeText } from '../calendar/format'
import { taskAlertLabel } from '../calendar/alerts'
import type { Calendar, EventOccurrence, Task } from '../engine'
import { Icon, IconButton } from '../icons'
import { useTasks } from '../local-data'
import { useOverlay } from '../overlays'
import { useMailActions } from '../store'
import { FONT, useSettings } from '../theme'
import { Button } from '../ui'
import { displaySpan } from '../calendar/dates'
import { isClosed, priorityMeta, statusMeta, taskKey } from './model'
import { openTask } from './open'
import { LabelChip, PriorityIcon, StatusIcon } from './pickers'

// ---------------------------------------------------------------------------
// Tasks on the calendar: every open task with a due date is drawn as an occurrence on a built-in,
// read-only "Tasks" calendar (key `task:<id>`), all-day for a date-only due and a half hour at its
// time otherwise. Nothing is copied into the events table, so moving a task's due moves it here.
// Selecting one shows a task card with Open in Tasks and Mark done.
// ---------------------------------------------------------------------------

export const TASKS_CALENDAR_ID = 'jefi-tasks'
const DAY = 86_400_000
const TIMED_LENGTH = 30 * 60_000

export const isTaskOccurrence = (o: Pick<EventOccurrence, 'calendarId'>) => o.calendarId === TASKS_CALENDAR_ID
export const taskIdOf = (o: Pick<EventOccurrence, 'id'>) => o.id

/** The Tasks calendar the views colour and label task occurrences with; it can't be edited or dragged. */
export const tasksCalendar = (color: string): Calendar => ({
  id: TASKS_CALENDAR_ID,
  source: 'local',
  name: 'Tasks',
  color,
  canWrite: false,
  isDefault: false,
  hidden: false,
  url: null,
  createdAt: 0,
  updatedAt: 0,
})

/** Open tasks due in [from, to), as calendar occurrences. */
export function taskOccurrences(tasks: readonly Task[], from: number, to: number): EventOccurrence[] {
  const out: EventOccurrence[] = []
  for (const t of tasks) {
    if (t.dueAt === null || isClosed(t.status)) continue
    const startAt = t.dueAt
    const endAt = t.dueAllDay ? startAt + DAY : startAt + TIMED_LENGTH
    const span = displaySpan({ startAt, endAt, allDay: t.dueAllDay })
    if (span.end <= from || span.start >= to) continue
    out.push({
      id: t.id,
      key: `task:${t.id}`,
      calendarId: TASKS_CALENDAR_ID,
      uid: t.uid,
      sequence: 0,
      accountId: null,
      title: t.title,
      startAt,
      endAt,
      allDay: t.dueAllDay,
      timeZone: null,
      location: null,
      description: null,
      url: null,
      status: 'confirmed',
      organizer: null,
      attendees: [],
      recurrence: null,
      exdates: [],
      recurringMasterId: null,
      recurrenceId: null,
      alarms: t.alarms,
      invite: null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      recurring: false,
      occurrenceStart: startAt,
    })
  }
  return out
}

/** Task occurrences for a calendar range, or none when Settings hides tasks from the calendar. */
export function useCalendarTasks(from: number, to: number): { occurrences: EventOccurrence[]; tasks: Task[] } {
  const { settings } = useSettings()
  const tasks = useTasks({ status: 'open' })
  const shown = settings.calendarShowsTasks
  return useMemo(() => ({ occurrences: shown && tasks ? taskOccurrences(tasks, from, to) : [], tasks: tasks ?? [] }), [shown, tasks, from, to])
}

/** The card a task on the calendar opens: what it is, when it's due, and ways to act on it. */
export function TaskCalendarCard({ task, side = 'right', onClose }: { task: Task; side?: 'left' | 'right' | 'top' | 'bottom'; onClose: () => void }) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const { setTaskDone } = useMailActions()
  useOverlay(true)
  const fallback = task.dueAllDay ? settings.defaultTaskAllDayAlert : settings.defaultTaskAlert
  const alarms = task.alarms ?? (fallback === null ? [] : [fallback])
  const reminder = alarms.length ? `Reminds you ${alarms.map((m) => taskAlertLabel(m, task.dueAllDay).toLowerCase()).join(', ')}` : 'No reminder'
  const { start } = displaySpan({ startAt: task.dueAt ?? 0, endAt: (task.dueAt ?? 0) + (task.dueAllDay ? DAY : TIMED_LENGTH), allDay: task.dueAllDay })
  return (
    <anchored side={side} align="start" gap={8} fit="snap" deferred priority={2} occlude style={{ backgroundColor: C.raised, borderRadius: 14 }}>
      <div
        testId="task-calendar-card"
        onMouseDownOutside={onClose}
        style={{
          width: 320,
          borderRadius: 14,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.overlayStrong,
          boxShadow: { offsetX: 0, offsetY: 14, blurRadius: 40, spreadRadius: 0, color: dark ? '#00000088' : '#00000030' },
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: 4, borderTopLeftRadius: 13, borderTopRightRadius: 13, backgroundColor: C.accent, pointerEvents: 'none' }} />
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', paddingTop: 14, paddingLeft: 16, paddingRight: 10, gap: 10 }}>
          <div style={{ paddingTop: 3 }}>
            <StatusIcon status={task.status} size={16} />
          </div>
          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>{`${taskKey(task)} · ${statusMeta(task.status).label}`}</text>
            <text testId="task-calendar-card-title" style={{ fontSize: 16, lineHeight: 22, fontWeight: 600, color: C.text, fontFamily: FONT }}>{task.title}</text>
            <text style={{ fontSize: 13, color: C.secondary, fontFamily: FONT }}>{`Due ${dayLine(start)}${task.dueAllDay ? '' : ` · ${timeText(task.dueAt!, true)}`}`}</text>
          </div>
          <IconButton icon="x" size={15} pad={30} tooltip="Close" onClick={onClose} testId="task-calendar-card-close" />
        </div>
        {task.priority || task.labels.length ? (
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingLeft: 42, paddingRight: 16, paddingTop: 10 }}>
            {task.priority ? (
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <PriorityIcon priority={task.priority} size={13} />
                <text style={{ fontSize: 12, color: C.secondary, fontFamily: FONT }}>{priorityMeta(task.priority).label}</text>
              </div>
            ) : null}
            {task.labels.map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }}>
          <Button label="Mark done" icon="check" onClick={() => void setTaskDone(task.id, true).then((t) => t && onClose())} testId="task-calendar-card-done" />
          <div style={{ flexGrow: 1 }} />
          <Button label="Open in Tasks" variant="primary" onClick={() => (onClose(), openTask(task.id))} testId="task-calendar-card-open" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 16, paddingBottom: 12 }}>
          <Icon name="bell" size={12} color={C.muted} />
          <text testId="task-calendar-card-reminder" style={{ fontSize: 11.5, color: C.muted, fontFamily: FONT }}>{reminder}</text>
        </div>
      </div>
    </anchored>
  )
}
