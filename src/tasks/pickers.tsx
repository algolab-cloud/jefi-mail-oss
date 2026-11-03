import { useState, type ReactNode } from 'react'
import type { TaskLabel, TaskPriority, TaskProject, TaskStatus } from '../engine'
import { Icon } from '../icons'
import { useTaskLabels, useTaskProjects } from '../local-data'
import { useMailActions } from '../store'
import { FONT, useSettings, type Colors } from '../theme'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui'
import { ALL_DAY_ALERTS, TIMED_ALERTS, taskAlertLabel } from '../calendar/alerts'
import { PRIORITIES, STATUSES, named, priorityMeta, statusMeta, type Tone } from './model'

// ---------------------------------------------------------------------------
// Linear-style property pickers: a status, priority, labels or project pill (or bare icon) that
// opens a menu of choices. Labels and projects can be made from the menu by typing a name.
// ---------------------------------------------------------------------------

/** A theme colour for a tone. */
export const toneColor = (tone: Tone | undefined, C: Colors) =>
  tone === 'amber' ? C.amber : tone === 'accent' ? C.accent : tone === 'red' ? C.red : tone === 'green' ? C.green : tone === 'muted' ? C.muted : C.secondary

/** New labels and projects cycle through these. */
export const SWATCHES = ['#8B5CF6', '#3E63DD', '#12A594', '#30A46C', '#F5A524', '#E5484D', '#D6409F', '#8D8D8D']

export function StatusIcon({ status, size = 15 }: { status: TaskStatus; size?: number }) {
  const { C } = useSettings()
  const meta = statusMeta(status)
  return <Icon name={meta.icon} size={size} color={toneColor(meta.tone, C)} />
}

export function PriorityIcon({ priority, size = 15 }: { priority: TaskPriority; size?: number }) {
  const { C } = useSettings()
  const meta = priorityMeta(priority)
  return <Icon name={meta.icon} size={size} color={toneColor(meta.tone, C)} />
}

/** The pill a property sits in, as in Linear's composer: an icon, a label, a subtle border. */
export function PropertyPill({ leading, label, onPress, active, muted, testId }: { leading?: ReactNode; label: string; onPress: () => void; active?: boolean; muted?: boolean; testId?: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onPress}
      onKeyDown={(event) => {
        if (event.key === 'space' || event.key === ' ') onPress()
      }}
      style={{
        height: 28,
        maxWidth: 220,
        minWidth: 0,
        paddingLeft: 8,
        paddingRight: 10,
        borderRadius: 14,
        backgroundColor: active ? C.overlayStrong : C.overlay,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        // Shrinks (and ellipsizes) in the sheet's narrow Properties column.
        flexShrink: 1,
        cursor: 'pointer',
        hover: { backgroundColor: C.overlayStrong },
      }}
    >
      {leading ? <div style={{ display: 'flex', pointerEvents: 'none' }}>{leading}</div> : null}
      <text style={{ fontSize: 12.5, fontWeight: 500, color: muted ? C.muted : C.text, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, pointerEvents: 'none' }}>{label}</text>
    </div>
  )
}

/** A bare icon that opens a picker (the list rows' status and priority). */
function IconTrigger({ children, onPress, active, label, testId }: { children: ReactNode; onPress: () => void; active: boolean; label: string; testId?: string }) {
  const { C } = useSettings()
  return (
    <div
      testId={testId}
      role="button"
      aria-label={label}
      onClick={onPress}
      style={{ width: 24, height: 24, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: active ? C.overlayStrong : '#00000001', cursor: 'pointer', hover: { backgroundColor: C.overlayStrong } }}
    >
      <div style={{ display: 'flex', pointerEvents: 'none' }}>{children}</div>
    </div>
  )
}

type Variant = 'pill' | 'icon'

export function StatusPicker({ status, onChange, variant = 'pill', testId = 'task-status' }: { status: TaskStatus; onChange: (status: TaskStatus) => void; variant?: Variant; testId?: string }) {
  const [open, setOpen] = useState(false)
  const meta = statusMeta(status)
  const pick = (next: TaskStatus) => {
    setOpen(false)
    if (next !== status) onChange(next)
  }
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      {variant === 'pill' ? (
        <PropertyPill leading={<StatusIcon status={status} size={14} />} label={meta.label} onPress={() => setOpen((v) => !v)} active={open} testId={testId} />
      ) : (
        <IconTrigger onPress={() => setOpen((v) => !v)} active={open} label={`Status: ${meta.label}`} testId={testId}>
          <StatusIcon status={status} />
        </IconTrigger>
      )}
      <Menu open={open} onClose={() => setOpen(false)} width={210} testId={`${testId}-menu`}>
        <MenuLabel>Change status</MenuLabel>
        {STATUSES.map((s) => (
          <MenuItem key={s.status} label={s.label} leading={<StatusIcon status={s.status} size={14} />} checked={s.status === status} onSelect={() => pick(s.status)} testId={`${testId}-${s.status}`} />
        ))}
      </Menu>
    </div>
  )
}

export function PriorityPicker({ priority, onChange, variant = 'pill', testId = 'task-priority' }: { priority: TaskPriority; onChange: (priority: TaskPriority) => void; variant?: Variant; testId?: string }) {
  const [open, setOpen] = useState(false)
  const meta = priorityMeta(priority)
  const pick = (next: TaskPriority) => {
    setOpen(false)
    if (next !== priority) onChange(next)
  }
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      {variant === 'pill' ? (
        <PropertyPill leading={<PriorityIcon priority={priority} size={14} />} label={priority ? meta.label : 'Priority'} muted={!priority} onPress={() => setOpen((v) => !v)} active={open} testId={testId} />
      ) : (
        <IconTrigger onPress={() => setOpen((v) => !v)} active={open} label={`Priority: ${meta.label}`} testId={testId}>
          <PriorityIcon priority={priority} />
        </IconTrigger>
      )}
      <Menu open={open} onClose={() => setOpen(false)} width={200} testId={`${testId}-menu`}>
        <MenuLabel>Set priority</MenuLabel>
        {PRIORITIES.map((p) => (
          <MenuItem key={p.priority} label={p.label} leading={<PriorityIcon priority={p.priority} size={14} />} checked={p.priority === priority} onSelect={() => pick(p.priority)} testId={`${testId}-${p.priority}`} />
        ))}
      </Menu>
    </div>
  )
}

/** A text field at the top of a menu that filters it, and makes a new one (or picks the one named) on Enter. */
function MenuSearch({ placeholder, value, onChange, onSubmit, testId }: { placeholder: string; value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; testId?: string }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 32, paddingLeft: 8, paddingRight: 8, marginBottom: 2, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderColor: C.divider }}>
      <Icon name="search" size={13} color={C.muted} />
      <input
        testId={testId}
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.value ?? '')}
        // Enter on a GPUIX input arrives as submit.
        onSubmit={(event) => onSubmit(event.value ?? value)}
        style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: FONT, color: C.text }}
      />
    </div>
  )
}

export function LabelPicker({ selected, onChange, variant = 'pill', testId = 'task-labels' }: { selected: readonly TaskLabel[]; onChange: (labelIds: string[]) => void; variant?: Variant; testId?: string }) {
  const { C } = useSettings()
  const labels = useTaskLabels() ?? []
  const { saveTaskLabel } = useMailActions()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  // Clearing a controlled GPUIX field after Enter needs a remount (the menu stays open for more).
  const [round, setRound] = useState(0)
  const clear = () => {
    setText('')
    setRound((n) => n + 1)
  }
  const ids = selected.map((l) => l.id)
  const shown = labels.filter((l) => l.name.toLowerCase().includes(text.trim().toLowerCase()))
  const exact = labels.some((l) => l.name.toLowerCase() === text.trim().toLowerCase())
  const toggle = (id: string) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  // Enter with a label's name picks it (read from the text Enter carries, not the state, which can lag).
  const create = async (name: string) => {
    const same = named(labels, name)
    if (same) {
      if (!ids.includes(same.id)) onChange([...ids, same.id])
      return clear()
    }
    if (!name.trim()) return
    const label = await saveTaskLabel({ name, color: SWATCHES[labels.length % SWATCHES.length]! })
    if (label) onChange([...ids, label.id])
    clear()
  }
  const close = () => {
    setOpen(false)
    setText('')
  }
  const label = selected.length === 0 ? 'Labels' : selected.length === 1 ? selected[0]!.name : `${selected.length} labels`
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      {variant === 'pill' ? (
        <PropertyPill
          leading={selected.length ? <LabelDots labels={selected} /> : <Icon name="tag" size={13} color={C.muted} />}
          label={label}
          muted={!selected.length}
          onPress={() => setOpen((v) => !v)}
          active={open}
          testId={testId}
        />
      ) : (
        <IconTrigger onPress={() => setOpen((v) => !v)} active={open} label="Labels" testId={testId}>
          <Icon name="tag" size={14} color={C.muted} />
        </IconTrigger>
      )}
      <Menu open={open} onClose={close} width={240} testId={`${testId}-menu`}>
        <MenuSearch key={round} placeholder="Add labels…" value={text} onChange={setText} onSubmit={(v) => void create(v)} testId={`${testId}-search`} />
        {shown.map((l) => (
          <MenuItem key={l.id} label={l.name} dot={l.color} checked={ids.includes(l.id)} onSelect={() => toggle(l.id)} testId={`${testId}-${l.id}`} />
        ))}
        {text.trim() && !exact ? <MenuItem icon="plus" label={`Create label “${text.trim()}”`} onSelect={() => void create(text)} testId={`${testId}-create`} /> : null}
        {!shown.length && !text.trim() ? <MenuLabel>Type a name to make a label</MenuLabel> : null}
      </Menu>
    </div>
  )
}

export function ProjectPicker({ projectId, onChange, variant = 'pill', testId = 'task-project' }: { projectId: string | null; onChange: (projectId: string | null) => void; variant?: Variant; testId?: string }) {
  const { C } = useSettings()
  const projects = useTaskProjects() ?? []
  const { saveTaskProject } = useMailActions()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const current = projects.find((p) => p.id === projectId) ?? null
  const shown = projects.filter((p) => p.name.toLowerCase().includes(text.trim().toLowerCase()))
  const exact = projects.some((p) => p.name.toLowerCase() === text.trim().toLowerCase())
  const close = () => {
    setOpen(false)
    setText('')
  }
  const pick = (id: string | null) => {
    close()
    if (id !== projectId) onChange(id)
  }
  // Enter with a project's name moves the task there.
  const create = async (name: string) => {
    const same = named(projects, name)
    if (same) return pick(same.id)
    if (!name.trim()) return
    const project = await saveTaskProject({ name, color: SWATCHES[projects.length % SWATCHES.length]! })
    if (project) pick(project.id)
  }
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      {variant === 'pill' ? (
        <PropertyPill leading={<ProjectGlyph project={current} />} label={current?.name ?? 'Project'} muted={!current} onPress={() => setOpen((v) => !v)} active={open} testId={testId} />
      ) : (
        <IconTrigger onPress={() => setOpen((v) => !v)} active={open} label="Project" testId={testId}>
          <ProjectGlyph project={current} />
        </IconTrigger>
      )}
      <Menu open={open} onClose={close} width={240} testId={`${testId}-menu`}>
        <MenuSearch placeholder="Move to project…" value={text} onChange={setText} onSubmit={(v) => void create(v)} testId={`${testId}-search`} />
        <MenuItem label="No project" leading={<Icon name="folder" size={14} color={C.muted} />} checked={!projectId} onSelect={() => pick(null)} testId={`${testId}-none`} />
        {shown.map((p) => (
          <MenuItem key={p.id} label={p.name} leading={<ProjectGlyph project={p} />} checked={p.id === projectId} onSelect={() => pick(p.id)} testId={`${testId}-${p.id}`} />
        ))}
        {text.trim() && !exact ? <MenuItem icon="plus" label={`Create project “${text.trim()}”`} onSelect={() => void create(text)} testId={`${testId}-create`} /> : null}
      </Menu>
    </div>
  )
}

/** A project's square in its colour, like Linear's project icons; a muted folder for none. */
export function ProjectGlyph({ project, size = 14 }: { project: Pick<TaskProject, 'color'> | null; size?: number }) {
  const { C } = useSettings()
  if (!project) return <Icon name="folder" size={size} color={C.muted} />
  return <Icon name="projectSquare" size={size} color={project.color} />
}

/** Up to three overlapping colour dots for a set of labels. */
export function LabelDots({ labels }: { labels: readonly Pick<TaskLabel, 'color'>[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      {labels.slice(0, 3).map((l, i) => (
        <div key={i} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: l.color, marginLeft: i ? -2 : 0 }} />
      ))}
    </div>
  )
}

/** A label as a row shows it: a dot and its name in a quiet pill. */
export function LabelChip({ label }: { label: Pick<TaskLabel, 'name' | 'color'> }) {
  const { C } = useSettings()
  return (
    <div style={{ height: 22, maxWidth: 130, paddingLeft: 7, paddingRight: 8, borderRadius: 11, backgroundColor: C.overlay, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0, pointerEvents: 'none' }}>
      <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: label.color, flexShrink: 0 }} />
      <text style={{ fontSize: 11.5, color: C.secondary, fontFamily: FONT, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>{label.name}</text>
    </div>
  )
}


/**
 * When to be reminded of a task: the default from Settings, none, or one of the presets (minutes
 * before the due, or for a date-only task a time on the day or before it). Only shown with a due.
 */
export function RemindPicker({ alarms, allDay, onChange, testId = 'task-remind' }: { alarms: number[] | null; allDay: boolean; onChange: (alarms: number[] | null) => void; testId?: string }) {
  const { C, settings } = useSettings()
  const [open, setOpen] = useState(false)
  const fallback = allDay ? settings.defaultTaskAllDayAlert : settings.defaultTaskAlert
  const describe = (minutes: number) => taskAlertLabel(minutes, allDay)
  // The pill stays short; the menu says what the default is.
  const current = alarms === null ? 'Default' : alarms.length ? alarms.map(describe).join(', ') : 'None'
  const pick = (next: number[] | null) => {
    setOpen(false)
    onChange(next)
  }
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <PropertyPill leading={<Icon name="bell" size={13} color={alarms?.length === 0 ? C.muted : C.secondary} />} label={current} muted={alarms?.length === 0} onPress={() => setOpen((v) => !v)} active={open} testId={testId} />
      <Menu open={open} onClose={() => setOpen(false)} width={240} testId={`${testId}-menu`}>
        <MenuLabel>Remind me</MenuLabel>
        <MenuItem label={`Default (${fallback === null ? 'none' : describe(fallback).toLowerCase()})`} checked={alarms === null} onSelect={() => pick(null)} testId={`${testId}-default`} />
        <MenuItem label="None" checked={alarms?.length === 0} onSelect={() => pick([])} testId={`${testId}-none`} />
        <MenuSeparator />
        {(allDay ? ALL_DAY_ALERTS : TIMED_ALERTS).map((m) => (
          <MenuItem key={m} label={describe(m)} checked={alarms?.length === 1 && alarms[0] === m} onSelect={() => pick([m])} testId={`${testId}-${m}`} />
        ))}
      </Menu>
    </div>
  )
}
