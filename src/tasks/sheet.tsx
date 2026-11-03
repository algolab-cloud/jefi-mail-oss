import { motion } from '@gpuix/react'
import { useRef, useState, type ReactNode } from 'react'
import type { Link, Task } from '../engine'
import { Icon, IconButton } from '../icons'
import { useKeys } from '../keys'
import { useMailActions } from '../store'
import { FONT, THEMES, TOPBAR_HEIGHT, useSettings } from '../theme'
import { useAutosave, type SaveState } from '../notes/autosave'
import { useFollowEnd } from '../notes/follow-end'
import { LinkChip } from '../notes/links'
import { formatWhen, liveFirst } from '../notes/model'
import { overlaysOpen } from '../overlays'
import { DueControls } from './bits'
import { dueDay, isClosed, statusMeta, taskKey } from './model'
import { LabelPicker, PriorityPicker, ProjectPicker, PropertyPill, RemindPicker, StatusIcon, StatusPicker } from './pickers'
import { requestCalendar } from '../calendar/state'

// ---------------------------------------------------------------------------
// A task's details in a wide sheet that slides over the list or board from the right, like an
// issue peek in Linear: title, notes, links and history on the left, its properties in a column on
// the right. J/K step through the list behind it; Esc closes it.
// ---------------------------------------------------------------------------

const SAVE_LABEL: Record<SaveState, string> = { idle: '', pending: 'Editing…', saving: 'Saving…', saved: 'Saved', failed: 'Not saved' }
const ORIGIN_LABEL: Record<Task['origin'], string> = { manual: 'Added by you', email: 'Made from an email', ai: 'Suggested by AI', menubar: 'Added from the menu bar' }

export function TaskSheet({
  task,
  now,
  onClose,
  onStep,
  onDelete,
  onOpenLink,
  eventsOpen,
}: {
  task: Task
  now: number
  onClose: () => void
  /** Moves to the next (1) or previous (-1) task in the list, if there is one. */
  onStep?: (by: 1 | -1) => void
  onDelete: (task: Task) => void
  onOpenLink: (link: Link) => void
  eventsOpen: boolean
}) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const { saveTask, unlinkTask } = useMailActions()
  const [title, setTitle] = useState(task.title)
  // Typing in the notes doesn't re-render the sheet (a render per keystroke cost a whole extra frame):
  // the field keeps its text, and this holds the latest of it for saving and deleting.
  const notes = useRef(task.notes)
  // A blank title isn't saved (a task needs one); the last good one stays until it's typed again.
  const autosave = useAutosave((value: { title: string; notes: string }) => saveTask({ id: task.id, title: value.title.trim() || task.title, notes: value.notes }))
  // The notes grow and the column scrolls (see follow-end.ts).
  const { page, field, follow } = useFollowEnd()
  const edit = (next: { title?: string; notes?: string }) => {
    if (next.notes !== undefined) {
      follow(notes.current, next.notes)
      notes.current = next.notes
    }
    const value = { title: next.title ?? title, notes: notes.current }
    if (next.title !== undefined) setTitle(next.title)
    autosave.schedule(value)
  }
  const closed = isClosed(task.status)

  useKeys((press, { typing }) => {
    if (overlaysOpen()) return false
    const key = press.key?.toLowerCase()
    if (key === 'escape') {
      onClose()
      return true
    }
    if (typing || press.modifiers?.cmd || press.modifiers?.ctrl) return false
    if (onStep && (key === 'j' || key === 'down')) return (onStep(1), true)
    if (onStep && (key === 'k' || key === 'up')) return (onStep(-1), true)
    return false
  })

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'row' }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        style={{ flexGrow: 1, minWidth: 0, backgroundColor: dark ? '#0000004D' : '#00000026' }}
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, left: 36 }}
        animate={{ opacity: 1, left: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        style={{ position: 'relative', width: '68%', minWidth: 620, maxWidth: 980, height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <div
          testId="task-sheet"
          style={{
            flexGrow: 1,
            minHeight: 0,
            // Solid even in Liquid Glass: the sheet covers the list, which would show through a pane colour.
            backgroundColor: THEMES[settings.theme].reading,
            borderLeftWidth: 1,
            borderColor: C.overlayStrong,
            boxShadow: { offsetX: -12, offsetY: 0, blurRadius: 40, spreadRadius: 0, color: dark ? '#00000080' : '#00000024' },
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ height: TOPBAR_HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 22, paddingRight: 12, gap: 8, borderBottomWidth: 1, borderColor: C.divider }}>
            <StatusIcon status={task.status} size={14} />
            <text testId="task-sheet-key" style={{ fontSize: 12.5, fontWeight: 500, color: C.secondary, fontFamily: FONT }}>{taskKey(task)}</text>
            <Icon name="chevronRight" size={12} color={C.ghost} />
            <text style={{ flexGrow: 1, minWidth: 0, fontSize: 12.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title.trim() || task.title}</text>
            {autosave.state !== 'idle' ? (
              <text testId="task-save-state" style={{ fontSize: 12, color: autosave.state === 'failed' ? C.accent : C.muted, fontFamily: FONT }}>
                {SAVE_LABEL[autosave.state]}
              </text>
            ) : null}
            {onStep ? (
              <>
                <IconButton icon="chevronDown" size={15} pad={28} onClick={() => onStep(1)} tooltip="Next task  J" testId="task-sheet-next" />
                <IconButton icon="chevronUp" size={15} pad={28} onClick={() => onStep(-1)} tooltip="Previous task  K" testId="task-sheet-previous" />
              </>
            ) : null}
            <IconButton
              icon="trash"
              size={15}
              pad={28}
              onClick={() => {
                autosave.cancel()
                onDelete({ ...task, title: title.trim() || task.title, notes: notes.current })
              }}
              tooltip="Delete task"
              testId="task-delete"
            />
            <IconButton icon="x" size={15} pad={28} onClick={onClose} tooltip="Close  Esc" testId="task-sheet-close" />
          </div>
          <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
            <div ref={page} style={{ flexGrow: 1, minWidth: 0, overflowY: 'scroll', paddingLeft: 44, paddingRight: 40, paddingTop: 30, paddingBottom: 30, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* A textarea so a long title wraps instead of scrolling out of sight; Enter (submit) adds no line. */}
              <textarea
                testId="task-title"
                value={title}
                placeholder="Task title"
                minRows={1}
                onChange={(event) => edit({ title: (event.value ?? '').replace(/\n+/g, ' ') })}
                onSubmit={() => {}}
                style={{ fontSize: 24, lineHeight: 32, fontWeight: 700, fontFamily: FONT, color: closed ? C.muted : C.text }}
              />
              <textarea
                ref={field}
                testId="task-notes"
                value={notes.current}
                placeholder="Add notes…"
                minRows={5}
                // Grows with the text; the column around it scrolls.
                maxRows={100000}
                onChange={(event) => edit({ notes: event.value ?? '' })}
                style={{ fontSize: 14.5, lineHeight: 23, fontFamily: FONT, color: C.text }}
              />
              {task.links.length ? (
                <Block title="Linked">
                  <div testId="task-links" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {liveFirst(task.links).map((link) => (
                      <LinkChip key={link.id} link={link} onOpen={onOpenLink} eventsOpen={eventsOpen} onRemove={() => void unlinkTask(link.id)} testId={`task-link-${link.id}`} />
                    ))}
                  </div>
                </Block>
              ) : null}
              <Block title="Activity">
                <Activity icon="plus" text={`${ORIGIN_LABEL[task.origin]} · ${formatWhen(task.createdAt, now)}`} />
                {task.updatedAt - task.createdAt > 60_000 ? <Activity icon="pencil" text={`Last changed · ${formatWhen(task.updatedAt, now)}`} /> : null}
                {closed && task.completedAt ? <Activity icon={task.status === 'done' ? 'check' : 'x'} text={`${statusMeta(task.status).label} · ${formatWhen(task.completedAt, now)}`} /> : null}
              </Block>
            </div>
            <div testId="task-properties" style={{ width: 290, flexShrink: 0, borderLeftWidth: 1, borderColor: C.divider, paddingLeft: 18, paddingRight: 16, paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <text style={{ fontSize: 12, fontWeight: 600, color: C.muted, fontFamily: FONT, paddingBottom: 8 }}>Properties</text>
              <Property label="Status">
                <StatusPicker status={task.status} onChange={(status) => void saveTask({ id: task.id, status })} />
              </Property>
              <Property label="Priority">
                <PriorityPicker priority={task.priority} onChange={(priority) => void saveTask({ id: task.id, priority })} />
              </Property>
              <Property label="Labels">
                <LabelPicker selected={task.labels} onChange={(labelIds) => void saveTask({ id: task.id, labelIds })} />
              </Property>
              <Property label="Project">
                <ProjectPicker projectId={task.projectId} onChange={(projectId) => void saveTask({ id: task.id, projectId })} />
              </Property>
              <Property label="Due">
                <DueControls due={{ dueAt: task.dueAt, dueAllDay: task.dueAllDay }} onChange={(due) => void saveTask({ id: task.id, ...due })} now={now} />
              </Property>
              {task.dueAt !== null && !closed ? (
                <Property label="Remind">
                  <RemindPicker alarms={task.alarms} allDay={task.dueAllDay} onChange={(alarms) => void saveTask({ id: task.id, alarms })} />
                </Property>
              ) : null}
              {task.dueAt !== null ? (
                <Property label="Calendar">
                  <PropertyPill leading={<Icon name="calendarDays" size={13} color={C.secondary} />} label="Show in calendar" onPress={() => requestCalendar({ date: dueDay(task)!, select: `task:${task.id}` })} testId="task-show-in-calendar" />
                </Property>
              ) : null}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTopWidth: 1, borderColor: C.divider }}>
      <text style={{ fontSize: 12, fontWeight: 600, color: C.muted, fontFamily: FONT }}>{title}</text>
      {children}
    </div>
  )
}

function Activity({ icon, text }: { icon: 'plus' | 'pencil' | 'check' | 'x'; text: string }) {
  const { C } = useSettings()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={11} color={C.secondary} />
      </div>
      <text style={{ fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>{text}</text>
    </div>
  )
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  const { C } = useSettings()
  return (
    <div style={{ minHeight: 38, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <text style={{ width: 62, flexShrink: 0, fontSize: 12.5, color: C.muted, fontFamily: FONT }}>{label}</text>
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>{children}</div>
    </div>
  )
}
