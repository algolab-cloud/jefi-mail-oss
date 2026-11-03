import { useState } from 'react'
import { DateField, TimeField } from '../calendar/fields'
import { allDayToLocal, atMinutes, minutesOfDay, startOfDay } from '../calendar/dates'
import { useWeekInfo } from '../calendar/hooks'
import type { Task } from '../engine'
import { Icon, IconButton } from '../icons'
import { FONT, useSettings } from '../theme'
import { Menu, MenuItem, MenuSeparator } from '../ui'
import { dueShortcuts, dueText, isClosed, isOverdue, withDueDay, type TaskDue } from './model'

// Small pieces the tasks view, the reader and the Make task form share.

/** The round checkbox a task is ticked off with. */
export function TaskCheck({ done, onToggle, size = 18, testId }: { done: boolean; onToggle: () => void; size?: number; testId?: string }) {
  const { C } = useSettings()
  return (
    <div
      role="checkbox"
      aria-checked={done}
      aria-label={done ? 'Mark as not done' : 'Mark as done'}
      tabIndex={0}
      testId={testId}
      // No bubbling in GPUIX: a click lands on the deepest painted element, so the row under this
      // checkbox doesn't also select. The near-clear fill makes the empty circle paint (and take clicks).
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'space' || event.key === ' ' || event.key === 'enter') onToggle()
      }}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size / 2,
        borderWidth: done ? 0 : 1.5,
        borderColor: C.muted,
        backgroundColor: done ? C.accent : '#00000001',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        hover: done ? { backgroundColor: C.accentHover } : { borderColor: C.accent },
      }}
    >
      {done ? <Icon name="check" size={size * 0.62} color={C.onAccent} /> : null}
    </div>
  )
}

/** A due date as a row shows it, red once it's past. */
export function DueLabel({ task, now }: { task: Pick<Task, 'dueAt' | 'dueAllDay' | 'status'>; now: number }) {
  const { C } = useSettings()
  const text = dueText(task, now)
  if (!text) return null
  const late = isOverdue(task, now)
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0, pointerEvents: 'none' }}>
      <Icon name="calendar" size={11} color={late ? C.red : C.muted} />
      <text style={{ fontSize: 11.5, color: late ? C.red : C.muted, fontFamily: FONT, whiteSpace: 'nowrap' }}>{text}</text>
    </div>
  )
}

/**
 * Due date editing: a menu of quick picks (Today, Tomorrow, Next week, No date), a date picker, and
 * a time once one is added. `now` anchors the quick picks.
 */
export function DueControls({ due, onChange, now, testId = 'task-due' }: { due: TaskDue; onChange: (due: TaskDue) => void; now: number; testId?: string }) {
  const { C } = useSettings()
  const { firstDay } = useWeekInfo()
  const [menu, setMenu] = useState(false)
  const localDay = due.dueAt === null ? null : due.dueAllDay ? allDayToLocal(due.dueAt) : startOfDay(due.dueAt)
  const pick = (day: number) => onChange(withDueDay(due, day))
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <div style={{ position: 'relative', display: 'flex' }}>
        <IconButton icon="calendar" size={15} pad={30} active={menu} color={due.dueAt !== null ? C.accent : undefined} onClick={() => setMenu((v) => !v)} tooltip="Due date" testId={`${testId}-menu`} />
        <Menu open={menu} onClose={() => setMenu(false)} width={200} testId={`${testId}-picks`}>
          {dueShortcuts(now).map((s) => (
            <MenuItem key={s.label} label={s.label} icon="calendar" testId={`${testId}-pick-${s.label.toLowerCase().replace(/\s+/g, '-')}`} onSelect={() => (setMenu(false), pick(s.day))} />
          ))}
          {due.dueAt !== null ? (
            <>
              <MenuSeparator />
              {due.dueAllDay ? (
                <MenuItem label="Add a time" icon="clock" testId={`${testId}-add-time`} onSelect={() => (setMenu(false), onChange({ dueAt: atMinutes(localDay!, 9 * 60), dueAllDay: false }))} />
              ) : (
                <MenuItem label="Remove the time" icon="clock" testId={`${testId}-remove-time`} onSelect={() => (setMenu(false), onChange(withDueDay({ dueAt: null, dueAllDay: true }, localDay!)))} />
              )}
              <MenuItem label="No due date" icon="x" testId={`${testId}-clear`} onSelect={() => (setMenu(false), onChange({ dueAt: null, dueAllDay: false }))} />
            </>
          ) : null}
        </Menu>
      </div>
      {localDay !== null ? <DateField value={localDay} onChange={pick} firstDay={firstDay} testId={`${testId}-date`} /> : <text style={{ fontSize: 13, color: C.muted, fontFamily: FONT }}>No due date</text>}
      {due.dueAt !== null && !due.dueAllDay ? (
        <TimeField value={minutesOfDay(due.dueAt)} day={localDay!} onChange={(minutes) => onChange({ dueAt: atMinutes(localDay!, minutes), dueAllDay: false })} testId={`${testId}-time`} />
      ) : null}
    </div>
  )
}

/**
 * A task linked to the conversation, as a chip under its subject: tick it off in place, or click
 * the title to open it in Tasks.
 */
export function TaskLinkChip({ task, now, onToggle, onOpen }: { task: Task; now: number; onToggle: () => void; onOpen: () => void }) {
  const { C } = useSettings()
  const done = isClosed(task.status)
  const due = done ? '' : dueText(task, now)
  const late = isOverdue(task, now)
  return (
    <div testId={`thread-link-task-${task.id}`} style={{ height: 24, maxWidth: 380, paddingLeft: 5, paddingRight: 9, borderRadius: 12, backgroundColor: C.chip, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <TaskCheck done={done} onToggle={onToggle} size={14} testId={`thread-task-check-${task.id}`} />
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open task ${task.title}`}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'enter' || event.key === 'space' || event.key === ' ') onOpen()
        }}
        style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1, cursor: 'pointer', hover: { opacity: 0.75 } }}
      >
        <text style={{ fontSize: 12, fontWeight: 500, color: done ? C.muted : C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1, pointerEvents: 'none' }}>{task.title}</text>
        {due ? <text style={{ fontSize: 12, color: late ? C.red : C.muted, fontFamily: FONT, whiteSpace: 'nowrap', flexShrink: 0, pointerEvents: 'none' }}>{due}</text> : null}
      </div>
    </div>
  )
}
