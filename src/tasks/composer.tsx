import { motion } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { useNow } from '../calendar/hooks'
import type { TaskInput, TaskLabel, TaskPriority, TaskStatus } from '../engine'
import { Icon, IconButton } from '../icons'
import { useKeys } from '../keys'
import { useTaskLabels } from '../local-data'
import { useOverlay } from '../overlays'
import { useMailActions } from '../store'
import { FONT, useSettings } from '../theme'
import { toast } from '../toast'
import { Button } from '../ui'
import { Switch } from '../calendar/fields'
import { DueControls } from './bits'
import { parseTaskText, taskKey, type TaskDue } from './model'
import { openTask } from './open'
import { LabelPicker, PriorityPicker, ProjectPicker, RemindPicker, StatusPicker } from './pickers'

// ---------------------------------------------------------------------------
// "New task": a sheet over the app like Linear's new-issue composer: the title, notes, and a row
// of property pills (status, priority, labels, project, due). Opened from New task, a group's +,
// the `c` key, the palette and the menu bar; mounted once at the shell (TaskComposerHost).
// ---------------------------------------------------------------------------

export type ComposerPrefill = Omit<TaskInput, 'id'>

let current: { key: number; prefill: ComposerPrefill } | null = null
let nextKey = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function openTaskComposer(prefill: ComposerPrefill = {}) {
  current = { key: ++nextKey, prefill }
  emit()
}
export function closeTaskComposer() {
  current = null
  emit()
}

/** Mount once inside MailProvider; shows the composer whenever openTaskComposer asks. */
export function TaskComposerHost() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = () => setTick((n) => n + 1)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
  return current ? <TaskComposer key={current.key} prefill={current.prefill} /> : null
}

function TaskComposer({ prefill }: { prefill: ComposerPrefill }) {
  const { C, settings } = useSettings()
  const dark = settings.theme === 'dark'
  const { saveTask } = useMailActions()
  const allLabels = useTaskLabels() ?? []
  const now = useNow()
  const [title, setTitle] = useState(prefill.title ?? '')
  const [notes, setNotes] = useState(prefill.notes ?? '')
  const [status, setStatus] = useState<TaskStatus>(prefill.status ?? 'todo')
  const [priority, setPriority] = useState<TaskPriority>(prefill.priority ?? 0)
  const [labelIds, setLabelIds] = useState<string[]>(prefill.labelIds ?? [])
  const [projectId, setProjectId] = useState<string | null>(prefill.projectId ?? null)
  // Reminders are picked for a timed or a date-only due; they don't carry over to the other kind.
  const [picked, setPicked] = useState<{ alarms: number[] | null; allDay: boolean }>({ alarms: prefill.alarms ?? null, allDay: prefill.dueAllDay ?? false })
  const alarmsFor = (due: TaskDue) => (due.dueAt !== null && picked.allDay === due.dueAllDay ? picked.alarms : null)
  const [due, setDue] = useState<TaskDue>({ dueAt: prefill.dueAt ?? null, dueAllDay: prefill.dueAllDay ?? false })
  // A date typed into the title ("Call Kenji tomorrow") sets the due, unless one was picked here. A
  // prefilled due (the Today view's, a due group's) is only the fallback, so typing a date still works.
  const [duePicked, setDuePicked] = useState(false)
  const [more, setMore] = useState(false)
  const [saving, setSaving] = useState(false)
  // Clearing a controlled GPUIX field needs a remount ("Create more" keeps the sheet open).
  const [round, setRound] = useState(0)
  const titleRef = useRef(title)
  titleRef.current = title
  useOverlay(true)

  const parsed = !duePicked && title.trim() ? parseTaskText(title, now) : null
  const shownDue = parsed && parsed.dueAt !== null ? { dueAt: parsed.dueAt, dueAllDay: parsed.dueAllDay } : due
  const labels = labelIds.map((id) => allLabels.find((l) => l.id === id)).filter((l): l is TaskLabel => !!l)

  const create = async (typed = titleRef.current) => {
    if (saving || !typed.trim()) return
    const fromText = !duePicked ? parseTaskText(typed, Date.now()) : null
    const input = fromText && fromText.dueAt !== null ? { title: fromText.title, dueAt: fromText.dueAt, dueAllDay: fromText.dueAllDay } : { title: typed, ...due }
    setSaving(true)
    const task = await saveTask({ ...input, notes, status, priority, labelIds, projectId, alarms: alarmsFor(input), origin: prefill.origin ?? (prefill.links?.length ? 'email' : 'manual'), links: prefill.links })
    setSaving(false)
    if (!task) return
    toast(`Created ${taskKey(task)}`, { description: task.title, action: { label: 'Open', onClick: () => openTask(task.id) } })
    if (!more) return closeTaskComposer()
    setTitle('')
    setNotes('')
    setRound((n) => n + 1)
  }

  useKeys((press) => {
    const key = press.key?.toLowerCase()
    if (key === 'escape') {
      closeTaskComposer()
      return true
    }
    if (key === 'enter' && (press.modifiers?.cmd || press.modifiers?.ctrl)) {
      void create()
      return true
    }
    // Everything else belongs to the fields, and nothing behind the sheet should act on it.
    return true
  })

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 100 }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? '#00000080' : '#0000004A' }}
        onClick={closeTaskComposer}
      />
      <motion.div initial={{ opacity: 0, top: 8 }} animate={{ opacity: 1, top: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }} style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div
          testId="task-composer"
          style={{
            width: 700,
            borderRadius: 16,
            backgroundColor: C.raised,
            borderWidth: 1,
            borderColor: C.overlayStrong,
            boxShadow: { offsetX: 0, offsetY: 24, blurRadius: 64, spreadRadius: 0, color: dark ? '#00000099' : '#00000038' },
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ height: 44, paddingLeft: 18, paddingRight: 10, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <div style={{ height: 22, paddingLeft: 7, paddingRight: 8, borderRadius: 11, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Icon name="circleCheck" size={12} color={C.accent} />
              <text style={{ fontSize: 12, fontWeight: 500, color: C.secondary, fontFamily: FONT }}>Tasks</text>
            </div>
            <Icon name="chevronRight" size={12} color={C.ghost} />
            <text style={{ flexGrow: 1, fontSize: 12.5, color: C.secondary, fontFamily: FONT }}>New task</text>
            <IconButton icon="x" size={15} pad={28} onClick={closeTaskComposer} tooltip="Close  Esc" testId="task-composer-close" />
          </div>
          <div style={{ paddingLeft: 20, paddingRight: 20, paddingTop: 2, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              key={`title-${round}`}
              testId="task-composer-title"
              autoFocus
              value={title}
              placeholder="Task title"
              onChange={(event) => setTitle(event.value ?? '')}
              // Enter on a GPUIX input arrives as submit, with the text as typed.
              onSubmit={(event) => void create(event.value ?? titleRef.current)}
              style={{ fontSize: 19, fontWeight: 600, fontFamily: FONT, color: C.text, height: 32 }}
            />
            <textarea
              key={`notes-${round}`}
              testId="task-composer-notes"
              value={notes}
              placeholder="Add notes…"
              minRows={3}
              onChange={(event) => setNotes(event.value ?? '')}
              style={{ fontSize: 14, lineHeight: 21, fontFamily: FONT, color: C.text }}
            />
          </div>
          <div style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 14, display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <StatusPicker status={status} onChange={setStatus} testId="task-composer-status" />
            <PriorityPicker priority={priority} onChange={setPriority} testId="task-composer-priority" />
            <LabelPicker selected={labels} onChange={setLabelIds} testId="task-composer-labels" />
            <ProjectPicker projectId={projectId} onChange={setProjectId} testId="task-composer-project" />
            <DueControls
              due={shownDue}
              now={now}
              testId="task-composer-due"
              onChange={(next) => {
                setDuePicked(true)
                setDue(next)
              }}
            />
            {shownDue.dueAt !== null ? <RemindPicker alarms={alarmsFor(shownDue)} allDay={shownDue.dueAllDay} onChange={(alarms) => setPicked({ alarms, allDay: shownDue.dueAllDay })} testId="task-composer-remind" /> : null}
          </div>
          <div style={{ height: 1, backgroundColor: C.divider }} />
          <div style={{ height: 54, paddingLeft: 16, paddingRight: 14, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {prefill.links?.length ? (
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Icon name="mail" size={12} color={C.muted} />
                <text style={{ fontSize: 12, color: C.muted, fontFamily: FONT }}>Links back to the email</text>
              </div>
            ) : null}
            <div style={{ flexGrow: 1 }} />
            <Switch on={more} onChange={setMore} label="Create more" testId="task-composer-more" />
            <Button label={saving ? 'Creating…' : 'Create task'} variant="primary" disabled={saving || !title.trim()} onClick={() => void create()} testId="task-composer-save" />
          </div>
        </div>
        <text style={{ alignSelf: 'center', paddingTop: 10, fontSize: 12, color: dark ? '#FFFFFF99' : '#FFFFFFCC', fontFamily: FONT }}>Enter or ⌘↵ to create · Esc to close</text>
      </motion.div>
    </div>
  )
}
